/**
 * 整文档级的数据操作层。
 *
 * 常规写入（标记、进度、统计等）走 `useOpsSync().dispatch()`；
 * 本文件承担需要整体替换文档的三类职责：
 * 1. 整文档覆盖写入（导入 / 历史快照恢复 / 手动「本地覆盖服务端」）——服务端记 `doc.replace`；
 * 2. 整文档拉取（「服务端覆盖本地」）；
 * 3. 版本快照防护（hash guard）与导出所需的本地压缩数据读取。
 */
import { del, get, set } from 'idb-keyval'
import {
  APP_VERSION,
  BACKUP_INDEX_KEY,
  BACKUP_KEY,
  SAVE_DICT_KEY,
  SAVE_SETTING_KEY,
  WEBSITE_VERSION_HASH,
} from '../config/env'
import { checkAndUpgradeSaveDict, checkAndUpgradeSaveSetting, shakeCommonDict } from '../utils'
import { getDefaultBaseState, getDefaultSettingState } from '../stores'
import type { BaseState } from '../stores/base.ts'
import { useBaseStore, useSettingStore } from '../stores'
import {
  getPracticeArticleCacheLocal,
  getPracticeWordCacheLocal,
  PRACTICE_ARTICLE_CACHE,
  PRACTICE_WORD_CACHE,
} from '../utils/cache'
import { readShadow, writeShadow } from '../utils/offlineOutbox'
import { fetchStoreOutcome, saveStoreValue } from '../utils/serverStorage'
import { noteDocumentWrite } from '../utils/opsBridge'
import type { BackupData, Snapshot } from '../types/types.ts'
import { SyncDataType } from '../types/enum'

function normalizeHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value.length > 0 ? value : null
}

type HashBackupIndexItem = {
  hash: string
  key: string
  createdAt: number
}

/**
 * 版本快照防护：commit hash 变化时保存一份本地快照，便于回滚。
 *
 * dict/setting 的权威副本在服务端，快照取自**影子副本**（最后一次成功读到的服务端文档）。
 */
export async function ensureHashGuardBeforeInit() {
  //@ts-ignore
  const runtimeConfig = useRuntimeConfig()

  try {
    const currentHash = normalizeHash(runtimeConfig?.public?.latestCommitHash)
    if (!currentHash) return

    const localHash = normalizeHash(await get(WEBSITE_VERSION_HASH))
    let res = true
    if (localHash !== currentHash) {
      res = await saveHashSnapshot(localHash ?? currentHash, '')
    }
    res && (await set(WEBSITE_VERSION_HASH, currentHash))
  } catch (e) {
    console.warn('init hash guard failed', e)
  }
}

export async function saveHashSnapshot(currentHash: string, previousHash: string | null): Promise<boolean> {
  const backupKey = `${BACKUP_KEY}${currentHash}`
  const createdAt = Date.now()

  const snapshot: Snapshot = {
    meta: {
      currentHash,
      previousHash,
      createdAt,
    },
    data: {
      dict: ((await readShadow('dict')) as string) ?? null,
      setting: ((await readShadow('setting')) as string) ?? null,
      [PRACTICE_WORD_CACHE.key]: ((await get(PRACTICE_WORD_CACHE.key)) as string) ?? null,
      [PRACTICE_ARTICLE_CACHE.key]: ((await get(PRACTICE_ARTICLE_CACHE.key)) as string) ?? null,
      [APP_VERSION.key]: APP_VERSION.version,
    } as Snapshot['data'],
  }
  if (!snapshot.data.dict) {
    return false
  }
  await set(backupKey, snapshot)

  const rawIndex = (await get(BACKUP_INDEX_KEY)) as HashBackupIndexItem[] | undefined
  const index = Array.isArray(rawIndex)
    ? rawIndex.filter(item => item && typeof item.hash === 'string' && typeof item.key === 'string')
    : []

  let rIndex = index.findIndex(item => item.hash === currentHash)
  if (rIndex === -1) {
    index.push({ hash: currentHash, key: backupKey, createdAt })
  } else {
    index[rIndex] = { hash: currentHash, key: backupKey, createdAt }
  }

  if (index.length > 15) {
    index.sort((a, b) => a.createdAt - b.createdAt)
    const removed = index.splice(0, index.length - 10)
    for (const item of removed) {
      await del(item.key)
    }
  }
  await set(BACKUP_INDEX_KEY, index)
  return true
}

export function useDataSyncPersistence() {
  const store = useBaseStore()
  const settingStore = useSettingStore()

  async function getLocalCompactDataByType(type: SyncDataType) {
    if (type === SyncDataType.practice_word) return await getPracticeWordCacheLocal()
    if (type === SyncDataType.practice_article) return await getPracticeArticleCacheLocal()
    if (type === SyncDataType.dict) return shakeCommonDict(store.$state)
    if (type === SyncDataType.setting) return settingStore.$state
  }

  /**
   * 整文档覆盖写入：导入数据 / 恢复历史快照 / 手动「本地覆盖服务端」。
   *
   * 这是权限最高的写操作，服务端会递增 revision 并广播 `doc.replace`，
   * 其它端收到后走全量重载。
   */
  async function forcePushLocalDataToRemote(data: BackupData['val']): Promise<boolean> {
    const now = new Date().toISOString()
    const dictSaved = await saveStoreValue(
      'dict',
      JSON.stringify({ ...(data as any).dict, updated_at: now }),
      { origin: 'import', label: 'force-push-local' }
    )
    const settingSaved = await saveStoreValue(
      'setting',
      JSON.stringify({ ...(data as any).setting, updated_at: now }),
      { origin: 'import', label: 'force-push-local' }
    )
    const wordCache = (data as any)?.[PRACTICE_WORD_CACHE.key]
    if (wordCache?.val != null) {
      await saveStoreValue(
        'practice_word',
        JSON.stringify({ version: PRACTICE_WORD_CACHE.version, val: wordCache.val, updated_at: now }),
        { origin: 'import' }
      )
    }
    const articleCache = (data as any)?.[PRACTICE_ARTICLE_CACHE.key]
    if (articleCache?.val != null) {
      await saveStoreValue(
        'practice_article',
        JSON.stringify({ version: PRACTICE_ARTICLE_CACHE.version, val: articleCache.val, updated_at: now }),
        { origin: 'import' }
      )
    }
    // 关键：告诉同步层整文档已被替换，否则之后本端的操作都会以过期 revision 提交并撞上 `*` 冲突域
    noteDocumentWrite('dict', Number(dictSaved.revision) || 0)
    noteDocumentWrite('setting', Number(settingSaved.revision) || 0)
    return dictSaved.ok && settingSaved.ok
  }

  /** 整文档拉取：用服务端数据覆盖本地（「服务端覆盖本地」） */
  async function pullAllRemoteToLocal(): Promise<boolean> {
    const [dictOutcome, settingOutcome] = await Promise.all([
      fetchStoreOutcome('dict'),
      fetchStoreOutcome('setting'),
    ])
    if (!dictOutcome.ok || !settingOutcome.ok) return false
    if (!dictOutcome.value || !settingOutcome.value) return false

    const nextDict = await checkAndUpgradeSaveDict(JSON.parse(dictOutcome.value))
    nextDict.load = true
    store.setState(nextDict as BaseState)

    const nextSetting = await checkAndUpgradeSaveSetting(JSON.parse(settingOutcome.value))
    nextSetting.load = true
    nextSetting._ignoreWatch = true
    settingStore.setState(nextSetting)

    await writeShadow('dict', dictOutcome.value)
    await writeShadow('setting', settingOutcome.value)
    noteDocumentWrite('dict', dictOutcome.revision)
    noteDocumentWrite('setting', settingOutcome.revision)
    return true
  }

  /**
   * 整份 state 的写入入口，当前不执行任何写入：全量 PUT 会覆盖服务端与其它写入者的并发修改。
   *
   * 保留此函数是为了让遗留调用点在 dev 下立刻暴露出来，而不是静默写坏数据。
   * 写入请使用 `useOpsSync().dispatch()/dispatchMany()`，等待落库用 `flushAll()`。
   */
  async function saveDictState(): Promise<void> {
    console.warn(
      '[useDataSyncPersistence] saveDictState() 不执行写入：请使用 useOpsSync().dispatch()/dispatchMany()，' +
        '并用 await useOpsSync().flushAll() 等待提交完成。'
    )
  }

  /** 清空全部数据：本地与服务端都回到默认状态（重来场景） */
  async function clear(): Promise<boolean> {
    const dict = getDefaultBaseState()
    dict.load = true
    const setting = getDefaultSettingState()
    setting.load = true
    const data = {
      dict: { val: dict, version: SAVE_DICT_KEY.version },
      setting: { val: setting, version: SAVE_SETTING_KEY.version },
      [PRACTICE_WORD_CACHE.key]: { val: null },
      [PRACTICE_ARTICLE_CACHE.key]: { val: null },
    }
    store.setState(dict)
    settingStore.setState(setting)
    return await forcePushLocalDataToRemote(data as unknown as BackupData['val'])
  }

  return {
    getLocalCompactDataByType,
    forcePushLocalDataToRemote,
    pullAllRemoteToLocal,
    saveDictState,
    clear,
  }
}
