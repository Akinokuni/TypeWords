import { useBaseStore } from '@/core/stores/base.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import type { PracticeState } from '@/core/stores/practice.ts'
import type { PracticeData as LegacyPracticeData, Question, TaskWords, Word } from '@/core/types/types.ts'
import {
  checkAndUpgradePracticeWordCache,
  getPracticeWordCacheLocalWithMeta,
  PRACTICE_WORD_CACHE,
  setPracticeWordCacheLocal,
  type LocalCacheResult,
} from '@/core/utils/cache.ts'
import { usePracticeServerBackup, flushPracticeKey } from '@/core/composables/usePracticeServerBackup.ts'
import { fetchStoreOutcome } from '@/core/utils/serverStorage.ts'
import type { PracticeSessionSnapshot } from './practice-flow-types.ts'

export type PracticeData = Omit<LegacyPracticeData, 'isTypingWrongWord' | 'question'> & {
  question: Question | null
}

export type PracticeWordCache = {
  taskWords: TaskWords
  practiceData?: PracticeData
  statStoreData?: PracticeState
  sessionSnapshot?: PracticeSessionSnapshot
}

export type PracticeWordCacheCompact = {
  taskWordsStr: { new: string[]; review: string[] }
  practiceData?: Omit<PracticeData, 'words' | 'wrongWords'> & {
    wordsStr: string[]
    wrongWordsStr: string[]
  }
  statStoreData?: PracticeState
  sessionSnapshot?: PracticeSessionSnapshot
}

export class UnsupportedPracticeCacheVersionError extends Error {
  constructor(public readonly version: number) {
    super(`UNSUPPORTED_PRACTICE_CACHE_VERSION:${version}`)
  }
}

export function addWrongWordKey(target: string[], word: string): boolean {
  if (!word || target.includes(word)) return false
  target.push(word)
  return true
}

export function resolveNewerRemotePracticeCacheTime(
  meta: { data_version?: number; updated_at?: string } | null,
  knownUpdatedAt: number
): number | null {
  if (!meta) return null
  const version = meta.data_version ?? 1
  if (version > PRACTICE_WORD_CACHE.version) {
    throw new UnsupportedPracticeCacheVersionError(version)
  }
  if (version !== PRACTICE_WORD_CACHE.version) return null
  const remoteUpdatedAt = Date.parse(meta.updated_at ?? '')
  return Number.isFinite(remoteUpdatedAt) && remoteUpdatedAt > knownUpdatedAt ? remoteUpdatedAt : null
}

export function getDefaultPracticeData(origin?: Partial<PracticeData>, val?: Partial<PracticeData>): PracticeData {
  return Object.assign(origin ?? {}, {
    index: 0,
    words: [],
    wrongWords: [],
    excludeWords: [],
    allWrongWords: [],
    wrongTimesMap: {},
    ratingMap: {},
    wrongTimes: 0,
    question: null,
    ...val,
  }) as PracticeData
}

function createWordMap(): Map<string, Word> {
  const store = useBaseStore()
  return new Map(store.sdict.words.map(word => [word.word, word]))
}

function restoreWords(words: unknown, wordMap: Map<string, Word>): Word[] {
  if (!Array.isArray(words)) return []
  return words
    .map(word => (typeof word === 'string' ? wordMap.get(word) : undefined))
    .filter((word): word is Word => !!word)
}

function serializePracticeWordCache(data: PracticeWordCache | null): PracticeWordCacheCompact | null {
  if (!data) return null
  const taskWordsStr = {
    new: data.taskWords.new.map(word => word.word),
    review: data.taskWords.review.map(word => word.word),
  }
  if (!data.practiceData && !data.statStoreData && !data.sessionSnapshot) return { taskWordsStr }
  if (!data.practiceData || !data.statStoreData || !data.sessionSnapshot) return null
  const { words, wrongWords, ...practiceData } = data.practiceData
  return {
    taskWordsStr,
    practiceData: {
      ...practiceData,
      wordsStr: words.map(word => word.word),
      wrongWordsStr: wrongWords.map(word => word.word),
    },
    statStoreData: data.statStoreData,
    sessionSnapshot: data.sessionSnapshot,
  }
}

function isCurrentSnapshot(value: unknown): value is PracticeSessionSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as PracticeSessionSnapshot
  const cursor = snapshot.cursor
  return (
    typeof snapshot.flowId === 'string' &&
    !!cursor &&
    Number.isInteger(cursor.nodeIndex) &&
    cursor.nodeIndex >= 0 &&
    Number.isInteger(cursor.stepIndex) &&
    cursor.stepIndex >= 0 &&
    typeof cursor.inWrongWordClear === 'boolean' &&
    (cursor.endActionIndex === null || (Number.isInteger(cursor.endActionIndex) && cursor.endActionIndex >= 0)) &&
    (cursor.loop === null ||
      (Number.isInteger(cursor.loop.startIndex) &&
        cursor.loop.startIndex >= 0 &&
        Number.isInteger(cursor.loop.endIndex) &&
        cursor.loop.endIndex >= cursor.loop.startIndex &&
        Number.isInteger(cursor.loop.subStepIndex) &&
        cursor.loop.subStepIndex >= 0))
  )
}

function restoreCurrentCache(value: unknown): PracticeWordCache | null {
  if (!value || typeof value !== 'object' || !('taskWordsStr' in value)) return null
  const data = value as PracticeWordCacheCompact
  if (!Array.isArray(data.taskWordsStr?.new) || !Array.isArray(data.taskWordsStr?.review)) return null
  const wordMap = createWordMap()
  const taskWords = {
    new: restoreWords(data.taskWordsStr.new, wordMap),
    review: restoreWords(data.taskWordsStr.review, wordMap),
  }
  if (!taskWords.new.length && !taskWords.review.length) return null
  if (!data.practiceData && !data.statStoreData && !data.sessionSnapshot) return { taskWords }
  if (!data.practiceData || !data.statStoreData || !isCurrentSnapshot(data.sessionSnapshot)) return null
  if (
    !Array.isArray(data.practiceData.wordsStr) ||
    !Array.isArray(data.practiceData.wrongWordsStr) ||
    !Number.isInteger(data.practiceData.index) ||
    data.practiceData.index < 0
  )
    return null
  const words = restoreWords(data.practiceData.wordsStr, wordMap)
  const wrongWords = restoreWords(data.practiceData.wrongWordsStr, wordMap)
  const index = words.length ? Math.min(Math.max(data.practiceData.index, 0), words.length - 1) : 0
  const { wordsStr: _wordsStr, wrongWordsStr: _wrongWordsStr, ...practiceData } = data.practiceData
  return {
    taskWords,
    practiceData: { ...practiceData, index, words, wrongWords, question: null },
    statStoreData: data.statStoreData,
    sessionSnapshot: data.sessionSnapshot,
  }
}

/**
 * 单词练习会话缓存的持久化。
 *
 * - 本地 IndexedDB 为主，服务端备份按 updated_at 做 LWW：本地缺失或比服务端旧时恢复服务端快照。
 * - 保存后立即尝试一次服务器备份，失败由「离开 / 静止 / 定时」通道重试。
 */
export function usePracticeWordPersistence() {
  const settingStore = useSettingStore()
  const { restoreIfStale } = usePracticeServerBackup()

  async function save(data: PracticeWordCache | null) {
    const compact = serializePracticeWordCache(data)
    const updatedAt = new Date().toISOString()
    // 本文件与 utils/cache 各自声明了同名 compact 类型（历史原因），此处按缓存层的结构写入
    await setPracticeWordCacheLocal(compact as any, updatedAt)
    // 不阻塞调用方：备份失败会由「离开/静止/定时」通道重试
    void flushPracticeKey('practice_word', PRACTICE_WORD_CACHE.key)
  }

  async function load(): Promise<PracticeWordCache | null> {
    let selected = (await getPracticeWordCacheLocalWithMeta()) as LocalCacheResult<unknown> | null

    // 本地缺失或比服务端旧 → 恢复服务端备份（restoreIfStale 会把信封回写到 IndexedDB）
    const restored = await restoreIfStale('practice_word', PRACTICE_WORD_CACHE.key)
    if (restored != null) {
      selected = (await getPracticeWordCacheLocalWithMeta()) as LocalCacheResult<unknown> | null
    }
    if (!selected) return null

    if (selected.version > PRACTICE_WORD_CACHE.version) {
      throw new UnsupportedPracticeCacheVersionError(selected.version)
    }

    if (selected.version !== PRACTICE_WORD_CACHE.version) {
      const upgraded = checkAndUpgradePracticeWordCache(
        {
          val: selected.val,
          version: selected.version,
          updated_at: selected.updated_at,
        },
        settingStore
      )
      if (upgraded.val == null) {
        await save(null)
        return null
      }
      const restoredCache = restoreCurrentCache(upgraded.val)
      if (!restoredCache) return null
      await save(restoredCache)
      return restoredCache
    }

    if (selected.val == null) return null
    return restoreCurrentCache(selected.val)
  }

  async function clear() {
    return await save(null)
  }

  /**
   * 服务端备份是否比本机已知时间更新（用于「检测到其他设备的新进度」对话框）。
   * 以服务端 `practice_word` 的写入时间为准，用于判断其它设备是否产生了更新的进度。
   */
  async function getRemoteUpdateTime(knownUpdatedAt: number): Promise<number | null> {
    const outcome = await fetchStoreOutcome('practice_word')
    if (!outcome.ok || !outcome.value) return null
    let serverTs = Date.parse(outcome.updatedAt ?? '')
    if (!Number.isFinite(serverTs)) {
      try {
        serverTs = Date.parse(JSON.parse(outcome.value)?.updated_at ?? '')
      } catch {
        serverTs = Number.NaN
      }
    }
    return Number.isFinite(serverTs) && serverTs > knownUpdatedAt ? serverTs : null
  }

  return { load, save, clear, getRemoteUpdateTime }
}
