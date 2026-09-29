import { useBaseStore } from '../stores'
import type { PracticeState } from '../stores/practice'
import type { PracticeData, TaskWords, Word } from '../types'
import type { PracticeArticleCache, PracticeWordCache, PracticeWordCacheCompact, PracticeWordCacheStored } from '../utils/cache'
import {
  getPracticeArticleCacheLocal,
  getPracticeWordCacheLocal,
  PRACTICE_ARTICLE_CACHE,
  PRACTICE_WORD_CACHE,
  setPracticeArticleCacheLocal,
  setPracticeWordCacheLocal,
} from '../utils/cache'
import { flushPracticeKey, usePracticeServerBackup } from './usePracticeServerBackup'
import { dispatchOp } from '../utils/opsBridge'
import dayjs from 'dayjs'

type DayGroup = { firstStart: number; totalSpend: number; daySegments: [number, number][] }

/** 统计条目的稳定身份：会话 + 该条起始时间，保证跨端去重与离线重放幂等 */
function buildStatisticId(sessionId: string | undefined, startDate: number, index: number): string {
  return `${sessionId || 'legacy'}:${startDate}:${index}`
}

/**
 * 将进行中的练习统计（PracticeState）落库到 store.sdict.statistics，并提交
 * `dict.statistics.push` 操作同步到服务端。用于结算、切换词典或修改练习设置前调用。
 * @param st - 来自缓存或内存的 PracticeState，为 null / spend=0 时直接返回
 */
export function flushStatToStore(st: PracticeState | null | undefined): void {
  const hasSegmentSpend = Array.isArray(st?.segments) && st.segments.some(([start, end]) => Number(end) > Number(start))
  if (!st || (!st.spend && !hasSegmentSpend)) return
  const store = useBaseStore()

  const baseInfo = {
    total: st.total,
    wrong: st.wrong,
    new: st.newWordNumber,
    review: st.reviewWordNumber,
  }
  const sessionId = (st as PracticeState & { sessionId?: string }).sessionId
  const entries: any[] = []

  if (Array.isArray(st.segments) && st.segments.length > 0) {
    const dayMap = new Map<string, DayGroup>()
    for (const [segStart, segEnd] of st.segments) {
      const dayKey = dayjs(segStart).format('YYYY-MM-DD')
      if (!dayMap.has(dayKey)) {
        dayMap.set(dayKey, { firstStart: segStart, totalSpend: 0, daySegments: [] })
      }
      const group = dayMap.get(dayKey)!
      group.totalSpend += segEnd - segStart
      group.daySegments.push([segStart, segEnd])
    }
    const dayKeys = Array.from(dayMap.keys())
    if (dayKeys.length === 1) {
      const group = dayMap.get(dayKeys[0])!
      entries.push({
        ...baseInfo,
        spend: group.totalSpend,
        startDate: group.firstStart,
        segments: group.daySegments,
        sessionRole: 'single',
      })
    } else {
      dayKeys.forEach((dayKey, idx) => {
        const group = dayMap.get(dayKey)!
        const sessionRole = idx === 0 ? 'start' : idx === dayKeys.length - 1 ? 'end' : 'middle'
        entries.push({
          ...baseInfo,
          spend: group.totalSpend,
          startDate: group.firstStart,
          segments: group.daySegments,
          sessionRole: sessionRole as 'start' | 'middle' | 'end',
        })
      })
    }
  } else {
    entries.push({
      ...baseInfo,
      spend: st.spend,
      startDate: st.startDate,
      sessionRole: 'single',
    })
  }

  entries.forEach((entry, index) => {
    entry.id = buildStatisticId(sessionId, entry.startDate, index)
    store.sdict.statistics.push(entry)
  })

  // 提交操作：服务端与其它端按 id 去重合并，学习记录永不丢失
  const dictKey = store.sdict.id ?? store.sdict.enName
  if (dictKey !== undefined && dictKey !== null && dictKey !== '') {
    void dispatchOp('dict.statistics.push', { list: 'word', dictKey, entries })
  }
}

function isCompactPracticeWordCache(data: PracticeWordCacheStored | null): data is PracticeWordCacheCompact {
  return !!data && 'taskWordsStr' in data
}

function createWordMap(): Map<string, Word> {
  const store = useBaseStore()
  return new Map(store.sdict.words.map(word => [word.word, word]))
}

function restoreWords(words: string[], wordMap: Map<string, Word>): Word[] {
  return words.map(word => wordMap.get(word)).filter((word): word is Word => !!word)
}

function serializePracticeWordCache(data: PracticeWordCache | null): PracticeWordCacheStored | null {
  if (!data) return null
  const { words, wrongWords, ...practiceDataRest } = data.practiceData
  return {
    taskWordsStr: {
      new: data.taskWords.new.map(v => v.word),
      review: data.taskWords.review.map(v => v.word),
    },
    practiceData: {
      ...practiceDataRest,
      wordsStr: words.map(v => v.word),
      wrongWordsStr: wrongWords.map(v => v.word),
    },
    statStoreData: data.statStoreData,
  }
}

function restorePracticeWordCache(data: PracticeWordCacheStored | null): PracticeWordCache | null {
  if (!data) return null
  if (!isCompactPracticeWordCache(data)) {
    if (!data.taskWords?.new.length && !data.taskWords?.review.length) return null
    return data
  }
  if (!data.taskWordsStr?.new.length && !data.taskWordsStr?.review.length) return null
  const wordMap = createWordMap()
  const taskWords: TaskWords = {
    new: restoreWords(data.taskWordsStr.new, wordMap),
    review: restoreWords(data.taskWordsStr.review, wordMap),
  }

  const words = restoreWords(data.practiceData?.wordsStr ?? [], wordMap)
  const wrongWords = restoreWords(data.practiceData?.wrongWordsStr ?? [], wordMap)
  const index = words.length ? Math.min(data.practiceData.index, words.length - 1) : 0

  const practiceData: PracticeData = {
    ...data.practiceData,
    index,
    words,
    wrongWords,
  }
  return {
    taskWords,
    practiceData,
    statStoreData: data.statStoreData,
  }
}

/**
 * 单词练习缓存的兼容读写入口（仅用于导出与清理）。
 *
 * 真正的练习页读写走 `practice-word-session.ts` 的 v2 实现（含 sessionSnapshot）。
 * 保留本入口是为了让导出（`getLocalDataCompact`）与「切换词典前清理」有统一的落点，
 * 该入口与练习页使用的实现共享同一份缓存格式，避免出现语义不同的同名实现。
 *
 * @deprecated 新代码请使用 `practice-word-session.ts` 的 `usePracticeWordPersistence`
 */
export function usePracticeWordPersistence() {
  const { restoreIfStale } = usePracticeServerBackup()

  async function load(): Promise<PracticeWordCache | null> {
    let local = await getPracticeWordCacheLocal()
    const restored = await restoreIfStale('practice_word', PRACTICE_WORD_CACHE.key)
    if (restored != null) local = await getPracticeWordCacheLocal()
    return restorePracticeWordCache(local)
  }

  async function fetch(): Promise<PracticeWordCache | null> {
    const restored = await restoreIfStale('practice_word', PRACTICE_WORD_CACHE.key)
    if (restored == null) return null
    return restorePracticeWordCache(await getPracticeWordCacheLocal())
  }

  async function getLocalDataCompact(): Promise<PracticeWordCacheStored | null> {
    return await getPracticeWordCacheLocal()
  }

  async function save(data: PracticeWordCache | null) {
    const compactData = serializePracticeWordCache(data)
    await setPracticeWordCacheLocal(compactData, new Date().toISOString())
    void flushPracticeKey('practice_word', PRACTICE_WORD_CACHE.key)
  }

  async function clear() {
    await setPracticeWordCacheLocal(null, new Date().toISOString())
    void flushPracticeKey('practice_word', PRACTICE_WORD_CACHE.key)
  }

  return { load, save, clear, fetch, getLocalDataCompact }
}

/** 文章练习缓存：整快照语义，按 updated_at 做 LWW（服务端拒绝更旧的快照） */
export function usePracticeArticlePersistence() {
  const { restoreIfStale } = usePracticeServerBackup()

  async function load(): Promise<PracticeArticleCache | null> {
    let local = await getPracticeArticleCacheLocal()
    const restored = await restoreIfStale('practice_article', PRACTICE_ARTICLE_CACHE.key)
    if (restored != null) local = await getPracticeArticleCacheLocal()
    return local
  }

  async function getLocalDataCompact(): Promise<PracticeArticleCache | null> {
    return await getPracticeArticleCacheLocal()
  }

  async function fetch(): Promise<PracticeArticleCache | null> {
    const restored = await restoreIfStale('practice_article', PRACTICE_ARTICLE_CACHE.key)
    if (restored == null) return null
    return await getPracticeArticleCacheLocal()
  }

  async function save(data: PracticeArticleCache | null): Promise<void> {
    await setPracticeArticleCacheLocal(data, new Date().toISOString())
    void flushPracticeKey('practice_article', PRACTICE_ARTICLE_CACHE.key)
  }

  async function clear() {
    await setPracticeArticleCacheLocal(null, new Date().toISOString())
    void flushPracticeKey('practice_article', PRACTICE_ARTICLE_CACHE.key)
  }

  return { load, save, clear, fetch, getLocalDataCompact }
}
