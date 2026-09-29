import { get, set } from 'idb-keyval'
import { PRACTICE_ARTICLE_CACHE, PRACTICE_WORD_CACHE } from '../utils/cache'
import { PRACTICE_SENTENCE_CACHE } from '@/composables/practice-sentences/practice-sentence-cache'
import { fetchStoreOutcome, saveStoreValue, type StoreKey } from '../utils/serverStorage'

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
/** 练习进行中的定时上传间隔（比「仅离开/静止」更早把进度送到服务端） */
const PERIODIC_FLUSH_MS = 60_000

export type PracticeFlushOutcome = 'skipped' | 'ok' | 'stale' | 'failed'

export interface PracticeFlushResult {
  attempted: number
  ok: number
  stale: number
  failed: number
}

function parseUpdatedAt(value: any): number {
  if (!value || typeof value !== 'object') return 0
  const ts = Date.parse(String(value.updated_at ?? ''))
  return Number.isFinite(ts) ? ts : 0
}

/** 把指定的本地练习缓存上传到服务器（供持久化层在本地保存后立即备份） */
export async function flushPracticeKey(
  serverKey: StoreKey,
  idbKey: string,
  options?: { keepalive?: boolean }
): Promise<PracticeFlushOutcome> {
  let local: unknown
  try {
    local = await get(idbKey)
  } catch {
    return 'skipped'
  }
  if (local == null || local === '') return 'skipped'
  const raw = typeof local === 'string' ? local : JSON.stringify(local)
  const saved = await saveStoreValue(serverKey, raw, options)
  if (!saved.ok) return 'failed'
  // 服务端按 LWW 拒绝了更旧的快照
  return saved.applied === false ? 'stale' : 'ok'
}

/**
 * 练习会话缓存的「双备份」：
 * - 正常运行读写本地 IndexedDB（快、零请求）；
 * - 离开页面 / 静止 / 定时 / 本地保存后上传到服务器作备份；
 * - 本地缺失或**本地比服务端旧**时从服务器恢复（判据是 updated_at，而不是「本地是否存在」）。
 *
 * 练习会话是整快照语义：不存在有意义的合并，只存在「哪次练习更靠后」，
 * 因此这里用 updated_at 做 LWW，服务端也会拒绝更旧的快照。
 */
export function usePracticeServerBackup() {
  /**
   * 本地缺失或过期时，从服务器恢复并回写本地。
   * - 拉取失败：保留本地，不做任何判断（不能把失败当成「服务端没有」）
   * - 服务端没有备份：返回 null
   * - 服务端更新：恢复并回写本地
   * - 本地更新或相同：返回 null，保留本地
   */
  async function restoreIfStale(serverKey: StoreKey, idbKey: string): Promise<unknown> {
    let localRaw: unknown
    try {
      localRaw = await get(idbKey)
    } catch {
      localRaw = undefined
    }

    const outcome = await fetchStoreOutcome(serverKey)
    if (!outcome.ok) return null
    if (!outcome.value) return null

    let server: any
    try {
      server = JSON.parse(outcome.value)
    } catch {
      return null
    }

    if (localRaw === undefined || localRaw === null) {
      await set(idbKey, outcome.value)
      return server?.val ?? null
    }

    let local: any
    try {
      local = typeof localRaw === 'string' ? JSON.parse(localRaw) : localRaw
    } catch {
      local = null
    }
    const localTs = parseUpdatedAt(local)
    const serverTs = parseUpdatedAt(server) || Date.parse(outcome.updatedAt ?? '') || 0
    if (serverTs <= localTs) return null

    await set(idbKey, outcome.value)
    return server?.val ?? null
  }

  /** @deprecated 旧名保留（语义已升级为「过期才恢复」） */
  const restoreIfAbsent = restoreIfStale

  /**
   * 把本地练习缓存上传到服务器。失败会返回统计结果而不是静默忽略：
   * 返回结果供调用方提示，并会在下一次（定时 / 切走 / 恢复网络）重试。
   */
  async function flushToServer(options?: { keepalive?: boolean }): Promise<PracticeFlushResult> {
    const result: PracticeFlushResult = { attempted: 0, ok: 0, stale: 0, failed: 0 }
    // 并发发出：pagehide 时浏览器可能在第一个请求后冻结，串行 await 会丢掉后面的 key
    const outcomes = await Promise.all(
      PRACTICE_BACKUPS.map(cfg => flushPracticeKey(cfg.serverKey, cfg.idbKey, options))
    )
    for (const outcome of outcomes) {
      if (outcome === 'skipped') continue
      result.attempted++
      if (outcome === 'ok') result.ok++
      else if (outcome === 'stale') result.stale++
      else result.failed++
    }
    if (result.failed) {
      console.warn('[practiceBackup] 练习缓存上传失败，将在下次重试', result)
    }
    return result
  }

  let disposed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let periodicTimer: ReturnType<typeof setInterval> | null = null

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
    // keepalive 请求在页面卸载后仍会被送出；这里不 await，尽早发起
    void flushToServer({ keepalive: true })
  }

  const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'touchstart', 'pointerdown'] as const

  /** 启动离开 / 静止 / 定时上传监听，返回清理函数 */
  function start(): () => void {
    disposed = false
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, resetIdle, { passive: true })
    }
    resetIdle()
    // 练习进行中也要定期上传，缩短「最后一组损失」的窗口
    if (periodicTimer) clearInterval(periodicTimer)
    periodicTimer = setInterval(() => {
      if (!disposed && !document.hidden) flush()
    }, PERIODIC_FLUSH_MS)
    return stop
  }

  function stop() {
    disposed = true
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (periodicTimer) clearInterval(periodicTimer)
    periodicTimer = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
    for (const evt of ACTIVITY_EVENTS) {
      window.removeEventListener(evt, resetIdle)
    }
  }

  return { restoreIfStale, restoreIfAbsent, flushToServer, start, stop }
}
