import { get, set } from 'idb-keyval'
import { PRACTICE_ARTICLE_CACHE, PRACTICE_WORD_CACHE } from '../utils/cache'
import { PRACTICE_SENTENCE_CACHE } from '@/composables/practice-sentences/practice-sentence-cache'
import { fetchStoreValue, saveStoreValue, type StoreKey } from '../utils/serverStorage'

interface PracticeBackupConfig {
  /** IndexedDB 里的 key */
  idbKey: string
  /** 服务器 SQLite 里的 key（/api/data/:key） */
  serverKey: StoreKey
}

const PRACTICE_BACKUPS: PracticeBackupConfig[] = [
  { idbKey: PRACTICE_WORD_CACHE.key, serverKey: 'practice_word' },
  { idbKey: PRACTICE_ARTICLE_CACHE.key, serverKey: 'practice_article' },
  { idbKey: PRACTICE_SENTENCE_CACHE.key, serverKey: 'practice_sentence' },
]

/** 静止多久（无键盘/鼠标/触摸活动）后，把本地练习缓存上传到服务器 */
const IDLE_FLUSH_MS = 30_000

/**
 * 练习会话缓存「双备份」：
 * - 正常运行使用本地 IndexedDB 缓存（读写都快）；
 * - 离开页面（visibilitychange hidden / pagehide）或静止（无活动）时上传到服务器作备份；
 * - 本地为空（换浏览器 / 清缓存）时从服务器恢复。
 */
export function usePracticeServerBackup() {
  /**
   * 仅当本地 IndexedDB 完全不存在该 key 时，才从服务器恢复并回写本地。
   * 本地已有数据（包含「已清空」的状态）时直接返回 null，不覆盖、不拉取。
   */
  async function restoreIfAbsent(serverKey: StoreKey, idbKey: string): Promise<unknown> {
    let raw: unknown
    try {
      raw = await get(idbKey)
    } catch {
      raw = undefined
    }
    if (raw !== undefined) return null

    const serverRaw = await fetchStoreValue(serverKey)
    if (!serverRaw) return null
    try {
      const parsed = JSON.parse(serverRaw)
      const val = (parsed as { val?: unknown })?.val ?? null
      if (val != null) {
        await set(idbKey, serverRaw)
      }
      return val
    } catch {
      return null
    }
  }

  /** 把本地练习缓存上传到服务器（离开 / 静止时调用） */
  async function flushToServer(options?: { keepalive?: boolean }): Promise<void> {
    for (const cfg of PRACTICE_BACKUPS) {
      let local: unknown
      try {
        local = await get(cfg.idbKey)
      } catch {
        continue
      }
      if (local == null || local === '') continue
      const raw = typeof local === 'string' ? local : JSON.stringify(local)
      await saveStoreValue(cfg.serverKey, raw, options)
    }
  }

  let disposed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function flush() {
    void flushToServer()
  }

  function resetIdle() {
    if (disposed) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(flush, IDLE_FLUSH_MS)
  }

  function onVisibilityChange() {
    if (document.hidden) {
      flush()
    } else {
      resetIdle()
    }
  }

  function onPageHide() {
    void flushToServer({ keepalive: true })
  }

  const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'touchstart', 'pointerdown'] as const

  /** 启动离开 / 静止上传监听，返回清理函数 */
  function start(): () => void {
    disposed = false
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, resetIdle, { passive: true })
    }
    resetIdle()
    return stop
  }

  function stop() {
    disposed = true
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
    for (const evt of ACTIVITY_EVENTS) {
      window.removeEventListener(evt, resetIdle)
    }
  }

  return { restoreIfAbsent, flushToServer, start, stop }
}
