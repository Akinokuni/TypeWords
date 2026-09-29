/**
 * 操作同步核心：写入以「操作」为单位提交，本地乐观应用后再推送，并按 revision 拉取增量。
 *
 * 职责：
 * - `dispatch`：唯一的写入入口。本地乐观应用 → 落 outbox → 尝试提交。
 * - `flush`   ：把 outbox 按序提交；失败时保留队列等待重试。
 * - `pull`    ：按 revision 拉增量并应用。
 * - `subscribe`：SSE 通道，服务端有变更时触发拉取。
 * - `resolveConflicts`：自动合并可交换操作，其余交给用户「弹窗选边」。
 *
 * 本模块是**单例**：多个组件调用 `useOpsSync()` 得到同一个实例，
 * 否则各自维护的 revision / localOpIds 会导致互相覆盖。
 */
import { reactive } from 'vue'
import { nanoid } from 'nanoid'
import { applyOperation, createOperation, isAutoMergeable, scopeOfOperation } from '#shared/domain/applyOperation'
import type { OpsScope } from '#shared/domain/applyOperation'
import type { Operation, OperationKind, OpConflict } from '#shared/types/ops'
import { useBaseStore } from '../stores/base.ts'
import { useSettingStore } from '../stores/setting.ts'
import { useRuntimeStore } from '../stores/runtime.ts'
import { APP_VERSION, SAVE_DICT_KEY, SAVE_SETTING_KEY } from '../config/env.ts'
import { checkAndUpgradeSaveDict, checkAndUpgradeSaveSetting, shakeCommonDict } from '../utils/index.ts'
import { fetchStoreOutcome, saveStoreValue } from '../utils/serverStorage.ts'
import { markBaseline, registerOpsBridge } from '../utils/opsBridge.ts'
import {
  enqueue,
  enqueueMany,
  getDeviceId,
  outboxSize,
  readOutbox,
  readScopeCursor,
  readSyncMeta,
  removeApplied,
  writeScopeCursor,
  writeShadow,
  writeSyncMeta,
} from '../utils/offlineOutbox.ts'

export type { OpsScope }

export interface ConflictDecisionItem {
  scope: OpsScope
  op: Operation
  conflict: OpConflict
}

export interface OpsSyncState {
  ready: boolean
  revisions: Record<OpsScope, number>
  /** 待用户选边的冲突（弹窗数据源） */
  conflictOpen: boolean
  conflictItems: ConflictDecisionItem[]
  conflictResolvers: ((choice: 'local' | 'server') => void) | null
}

/** 单条 op 自动合并的最大重试次数，超过则升级为用户决策 */
const AUTO_MERGE_MAX_RETRY = 2

/** 冲突处理的轮次上限，防止两端持续抢占导致无限弹窗 */
const CONFLICT_ROUND_LIMIT = 3

/** 影子副本写入节流：避免每次 flush 都序列化整份 dict */
const SHADOW_MIN_INTERVAL_MS = 30_000

/** SSE 收到通知后的拉取去抖 */
const PULL_DEBOUNCE_MS = 200

/** 操作 → 目标文档；与服务端校验逻辑共用同一份实现 */
export const scopeOfKind = scopeOfOperation

const center = reactive<OpsSyncState>({
  ready: false,
  revisions: { dict: 0, setting: 0 },
  conflictOpen: false,
  conflictItems: [],
  conflictResolvers: null,
})

let instance: ReturnType<typeof createOpsSync> | null = null

export function useOpsSync() {
  if (!instance) instance = createOpsSync()
  return instance
}

/** 冲突中心状态（供弹窗组件读取，不触发实例创建之外的副作用） */
export function useSyncConflictCenter() {
  const sync = useOpsSync()
  return {
    state: center,
    isOpen: () => center.conflictOpen,
    items: () => center.conflictItems,
    decide: (choice: 'local' | 'server') => sync.decideConflicts(choice),
  }
}

function createOpsSync() {
  const store = useBaseStore()
  const settingStore = useSettingStore()
  const runtimeStore = useRuntimeStore()

  const localOpIds = new Set<string>()
  const autoMergeRetries = new Map<string, number>()
  const flushing: Record<OpsScope, Promise<void> | null> = { dict: null, setting: null }
  const pendingFlushTimers: Record<OpsScope, ReturnType<typeof setTimeout> | null> = { dict: null, setting: null }
  /** 本端刚完成的整文档替换 revision：收到对应 doc.replace 时跳过自触发重载 */
  const ignoredDocReplace = new Map<string, number>()
  let lastShadowAt = 0
  let pullTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  let initialized = false

  function targetOf(scope: OpsScope) {
    return scope === 'setting' ? settingStore.$state : store.$state
  }

  /**
   * 状态指纹：用于开发期探针，检测「未经 dispatch 的直接写入」。
   * 覆盖全部会被同步的维度（词典数、各集合规模、进度、FSRS 卡片数、笔记数、学习指针）。
   */
  function fingerprint(scope: OpsScope): string {
    if (scope === 'setting') {
      const state = settingStore.$state as Record<string, any>
      const keys = Object.keys(state)
        .filter(key => key !== 'load' && key !== '_ignoreWatch')
        .sort()
      return keys.map(key => key + '=' + JSON.stringify(state[key])).join('|')
    }
    const state = store.$state as any
    const bookSignature = (list: any[]) =>
      (list ?? [])
        .map(d => [d?.id ?? d?.enName, (d?.words ?? []).length, (d?.articles ?? []).length, d?.lastLearnIndex, d?.complete ? 1 : 0, (d?.statistics ?? []).length].join(':'))
        .join(',')
    return [
      (state.word?.bookList ?? []).length,
      state.word?.studyIndex,
      bookSignature(state.word?.bookList),
      state.article?.studyIndex,
      bookSignature(state.article?.bookList),
      Object.keys(state.fsrsData ?? {}).length,
      Object.keys(state.noteData ?? {}).length,
    ].join('|')
  }

  function setSyncState(state: 'idle' | 'online' | 'offline' | 'unavailable' | 'syncing' | 'conflict') {
    runtimeStore.syncState = state
  }

  async function refreshPendingCount() {
    runtimeStore.pendingOps = await outboxSize()
  }

  /* ─────────────────────────── 影子副本 ─────────────────────────── */

  async function writeShadowFromLocal(scope: OpsScope, force = false) {
    const now = Date.now()
    if (!force && now - lastShadowAt < SHADOW_MIN_INTERVAL_MS) return
    lastShadowAt = now
    const version = scope === 'setting' ? SAVE_SETTING_KEY.version : SAVE_DICT_KEY.version
    const envelope = {
      val: targetOf(scope),
      version,
      revision: center.revisions[scope],
      updated_at: new Date().toISOString(),
    }
    try {
      await writeShadow(scope, JSON.stringify(envelope))
    } catch (error) {
      console.warn('[opsSync] writeShadow failed', error)
    }
  }

  /* ─────────────────────────── 提交 ─────────────────────────── */

  function stripOp(op: Operation): Operation {
    return {
      opId: op.opId,
      kind: op.kind,
      payload: op.payload,
      clientTs: op.clientTs,
      baseRevision: op.baseRevision,
      origin: op.origin,
      entityKeys: op.entityKeys,
      force: op.force,
    }
  }

  async function postOps(scope: OpsScope, ops: Operation[]) {
    return await $fetch<{
      revision: number
      applied: Array<{ opId: string; revision: number; changed: boolean }>
      conflicts: OpConflict[]
    }>('/api/ops', {
      method: 'POST',
      body: { scope, ops: ops.map(stripOp) },
    })
  }

  async function flush(scope: OpsScope): Promise<void> {
    if (flushing[scope]) return flushing[scope]
    const task = (async () => {
      const queue = await readOutbox()
      const scoped = queue.filter(op => scopeOfKind(op.kind) === scope)
      if (!scoped.length) {
        await refreshPendingCount()
        return
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setSyncState('offline')
        await refreshPendingCount()
        return
      }
      setSyncState('syncing')
      try {
        const res = await postOps(scope, scoped)
        center.revisions[scope] = Number(res.revision) || center.revisions[scope]
        await removeApplied((res.applied ?? []).map(item => item.opId))
        await writeScopeCursor(scope, { revision: center.revisions[scope], lastSyncedAt: Date.now() })
        await refreshPendingCount()
        if (res.conflicts?.length) {
          await resolveConflicts(scope, res.conflicts)
        }
        setSyncState(center.conflictOpen ? 'conflict' : 'online')
        await writeShadowFromLocal(scope)
      } catch (error) {
        // 失败时保留队列等待重试，不静默丢弃
        console.warn('[opsSync] flush 失败，操作保留在队列中等待重试', error)
        setSyncState('offline')
        await refreshPendingCount()
      }
    })()
    flushing[scope] = task
    try {
      await task
    } finally {
      flushing[scope] = null
    }
  }

  function scheduleFlush(scope: OpsScope, delay = 250) {
    if (pendingFlushTimers[scope]) clearTimeout(pendingFlushTimers[scope]!)
    pendingFlushTimers[scope] = setTimeout(() => {
      pendingFlushTimers[scope] = null
      void flush(scope)
    }, delay)
  }

  /* ─────────────────────────── 拉取 ─────────────────────────── */

  async function pull(scope: OpsScope): Promise<void> {
    try {
      const since = center.revisions[scope] ?? 0
      const res = await $fetch<{
        revision: number
        mode: 'ops' | 'snapshot-required'
        ops: Array<Operation & { revision: number }>
      }>('/api/ops', { query: { since } })

      if (res.mode === 'snapshot-required') {
        await hardReload(scope)
        return
      }

      const target = targetOf(scope)
      let needReload = false
      let sessionStale = false

      for (const op of res.ops ?? []) {
        if (op.kind === 'doc.replace') {
          if (ignoredDocReplace.get(scope) === op.revision) continue
          needReload = true
          continue
        }
        if (op.kind === 'practice.session.set') {
          sessionStale = true
          continue
        }
        if (localOpIds.has(op.opId)) {
          // 过滤自己的回环（本端已经乐观应用过）
          localOpIds.delete(op.opId)
          continue
        }
        applyOperation(target, op)
      }

      center.revisions[scope] = Number(res.revision) || center.revisions[scope]
      await writeScopeCursor(scope, { revision: center.revisions[scope], lastSyncedAt: Date.now() })
      setSyncState(center.conflictOpen ? 'conflict' : 'online')
      markBaseline(scope)
      if (sessionStale) runtimeStore.sessionStale = true

      if (needReload) {
        await hardReload(scope)
      } else if (scope === 'setting') {
        snapshotSetting()
      }
    } catch (error) {
      console.warn('[opsSync] pull 失败', error)
      setSyncState('offline')
    }
  }

  async function pullAll() {
    await pull('dict')
    await pull('setting')
  }

  function schedulePull() {
    if (pullTimer) clearTimeout(pullTimer)
    pullTimer = setTimeout(() => {
      pullTimer = null
      void pullAll()
    }, PULL_DEBOUNCE_MS)
  }

  /** 全量重载：用于 snapshot-required、doc.replace、以及「冲突选服务端」 */
  async function hardReload(scope: OpsScope): Promise<void> {
    const outcome = await fetchStoreOutcome(scope)
    if (!outcome.ok) {
      setSyncState('unavailable')
      return
    }
    if (!outcome.value) return
    try {
      const parsed = JSON.parse(outcome.value)
      if (scope === 'setting') {
        const next = await checkAndUpgradeSaveSetting(parsed)
        next.load = true
        next._ignoreWatch = true
        settingStore.setState(next)
        snapshotSetting()
      } else {
        const next = await checkAndUpgradeSaveDict(parsed)
        next.load = true
        store.setState(next as any)
      }
      center.revisions[scope] = outcome.revision
      await writeScopeCursor(scope, { revision: outcome.revision, lastSyncedAt: Date.now() })
      await writeShadow(scope, outcome.value)
      markBaseline(scope)
      setSyncState(center.conflictOpen ? 'conflict' : 'online')
    } catch (error) {
      console.error('[opsSync] hardReload 失败', error)
    }
  }

  /* ─────────────────────────── 冲突处理 ─────────────────────────── */

  function requestUserDecision(items: ConflictDecisionItem[]): Promise<'local' | 'server'> {
    return new Promise(resolve => {
      center.conflictItems = items
      center.conflictOpen = true
      setSyncState('conflict')
      center.conflictResolvers = (choice: 'local' | 'server') => {
        center.conflictOpen = false
        center.conflictItems = []
        center.conflictResolvers = null
        resolve(choice)
      }
    })
  }

  async function resolveConflicts(scope: OpsScope, conflicts: OpConflict[], round = 1): Promise<void> {
    const queue = await readOutbox()
    const retry: Operation[] = []
    const needUser: ConflictDecisionItem[] = []

    for (const conflict of conflicts) {
      const op = queue.find(item => item.opId === conflict.opId)
      if (!op) continue
      const attempts = autoMergeRetries.get(op.opId) ?? 0
      if (isAutoMergeable(op.kind) && attempts < AUTO_MERGE_MAX_RETRY) {
        autoMergeRetries.set(op.opId, attempts + 1)
        retry.push(op)
      } else {
        needUser.push({ scope, op, conflict })
      }
    }

    // 先拿到最新基准，再决定重试或询问用户
    await pull(scope)

    if (retry.length) {
      const rebased = retry.map(op => ({ ...op, baseRevision: center.revisions[scope] }))
      try {
        const res = await postOps(scope, rebased)
        center.revisions[scope] = Number(res.revision) || center.revisions[scope]
        await removeApplied((res.applied ?? []).map(item => item.opId))
        await writeScopeCursor(scope, { revision: center.revisions[scope], lastSyncedAt: Date.now() })
        if (res.conflicts?.length && round < CONFLICT_ROUND_LIMIT) {
          await resolveConflicts(scope, res.conflicts, round + 1)
        }
      } catch (error) {
        console.warn('[opsSync] 自动合并重试失败，操作留在队列中', error)
      }
    }

    if (needUser.length) {
      const choice = await requestUserDecision(needUser)
      await applyConflictDecision(scope, needUser, choice, round)
    }
    await refreshPendingCount()
  }

  /**
   * 「弹窗选边」的落地：
   * - 保留本地：用当前 revision 作基准、带 force 重新提交（force 允许进度等单调值被显式覆盖）。
   * - 采用服务端：丢弃本地这几个操作，并从服务端全量重载该 scope。
   *
   * 注意：只有「对应的强制操作确实被服务端接受」时才移除原始操作；
   * 若重投期间又被别的写入者抢先（再次返回冲突），原始操作**继续留在队列**，
   * 否则用户在弹窗里选择的「保留本机」意图会被静默丢弃。
   */
  async function applyConflictDecision(
    scope: OpsScope,
    items: ConflictDecisionItem[],
    choice: 'local' | 'server',
    round = 1
  ): Promise<void> {
    if (choice === 'server') {
      await removeApplied(items.map(item => item.op.opId))
      runtimeStore.lastConflictChoice = 'server'
      await hardReload(scope)
      return
    }
    const forced = items.map(item => ({
      ...item.op,
      opId: nanoid(),
      baseRevision: center.revisions[scope],
      force: true,
      clientTs: new Date().toISOString(),
    }))
    try {
      const res = await postOps(scope, forced)
      center.revisions[scope] = Number(res.revision) || center.revisions[scope]
      const accepted = new Set((res.applied ?? []).map(item => item.opId))
      const drop = [...accepted] as string[]
      forced.forEach((op, index) => {
        if (accepted.has(op.opId)) drop.push(items[index].op.opId)
      })
      await removeApplied(drop)
      await writeScopeCursor(scope, { revision: center.revisions[scope], lastSyncedAt: Date.now() })
      runtimeStore.lastConflictChoice = 'local'
      if (res.conflicts?.length) {
        if (round < CONFLICT_ROUND_LIMIT) {
          await resolveConflicts(scope, res.conflicts, round + 1)
        } else {
          console.warn('[opsSync] 冲突轮次达到上限，未解决的操作保留在队列中，稍后重试')
          setSyncState('conflict')
        }
      }
    } catch (error) {
      console.error('[opsSync] 保留本地失败，操作仍在队列中', error)
      setSyncState('offline')
    }
  }

  /** 供弹窗组件调用 */
  async function decideConflicts(choice: 'local' | 'server') {
    center.conflictResolvers?.(choice)
  }

  /* ─────────────────────────── 写入入口 ─────────────────────────── */

  async function dispatch(
    kind: OperationKind,
    payload: Record<string, any> = {},
    options: { scope?: OpsScope; force?: boolean; immediate?: boolean } = {}
  ): Promise<{ changed: boolean; opId: string }> {
    const scope = options.scope ?? scopeOfKind(kind)
    const op = createOperation({
      opId: nanoid(),
      kind,
      payload,
      baseRevision: center.revisions[scope] ?? 0,
      origin: 'browser',
      force: options.force,
    })
    const { changed } = applyOperation(targetOf(scope), op)
    markBaseline(scope)
    localOpIds.add(op.opId)
    await enqueue(op)
    await refreshPendingCount()
    if (options.immediate === true) {
      await flush(scope)
    } else {
      scheduleFlush(scope)
    }
    return { changed, opId: op.opId }
  }

  /** 批量提交（例如一次练习结算产生的多条操作），保证同批同基准 */
  async function dispatchMany(
    ops: Array<{ kind: OperationKind; payload?: Record<string, any>; force?: boolean }>,
    options: { immediate?: boolean } = {}
  ): Promise<void> {
    if (!ops.length) return
    const built: Operation[] = []
    for (const item of ops) {
      const scope = scopeOfKind(item.kind)
      const op = createOperation({
        opId: nanoid(),
        kind: item.kind,
        payload: item.payload ?? {},
        baseRevision: center.revisions[scope] ?? 0,
        origin: 'browser',
        force: item.force,
      })
      applyOperation(targetOf(scope), op)
      markBaseline(scope)
      localOpIds.add(op.opId)
      built.push(op)
    }
    await enqueueMany(built)
    await refreshPendingCount()
    if (options.immediate === true) {
      await flushAll()
    } else {
      scheduleFlush('dict')
      scheduleFlush('setting')
    }
  }

  async function flushAll(): Promise<void> {
    await flush('dict')
    await flush('setting')
  }

  /* ─────────────────────────── 设置快照 diff ─────────────────────────── */

  let settingSnapshot: Record<string, any> = {}

  const SETTING_IGNORED_KEYS = new Set(['load', '_ignoreWatch'])

  function snapshotSetting() {
    const next: Record<string, any> = {}
    for (const [key, value] of Object.entries(settingStore.$state as Record<string, any>)) {
      if (SETTING_IGNORED_KEYS.has(key)) continue
      next[key] = value
    }
    settingSnapshot = next
  }

  /** 把设置项的变化 diff 成一批 setting.patch 操作 */
  async function collectSettingPatch(): Promise<Record<string, any>> {
    const patch: Record<string, any> = {}
    for (const [key, value] of Object.entries(settingStore.$state as Record<string, any>)) {
      if (SETTING_IGNORED_KEYS.has(key)) continue
      if (settingSnapshot[key] !== value) patch[key] = value
    }
    if (Object.keys(patch).length) {
      // 立即更新快照，避免同一变更被重复 dispatch
      Object.assign(settingSnapshot, patch)
    }
    return patch
  }

  /* ─────────────────────────── 启动与订阅 ─────────────────────────── */

  function subscribe(): () => void {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {}
    let es: EventSource | null = null
    let retry = 0
    let closed = false

    const connect = () => {
      if (closed) return
      try {
        es = new EventSource('/api/ops/stream')
      } catch (error) {
        console.warn('[opsSync] EventSource 创建失败', error)
        return
      }
      es.onopen = () => {
        retry = 0
        // 连上先补齐断线期间的增量
        schedulePull()
      }
      es.onmessage = event => {
        if (!event.data || event.data === 'ping') return
        schedulePull()
      }
      es.onerror = () => {
        es?.close()
        es = null
        retry = Math.min(retry + 1, 6)
        setTimeout(connect, 1000 * 2 ** retry)
      }
    }

    connect()
    unsubscribe = () => {
      closed = true
      es?.close()
      es = null
    }
    return unsubscribe
  }

  /**
   * 启动：先把离线期间积压的操作推上去，再拉取他人期间的写入。
   *
   * 顺序很关键：如果先拉后推，本地积压的旧操作会用更旧的 baseRevision 提交，
   * 从而把本可自动合并的场景变成冲突；先推则服务端以最新状态为基准应用我们的操作。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    const meta = await readSyncMeta()
    const dictCursor = await readScopeCursor('dict')
    const settingCursor = await readScopeCursor('setting')
    center.revisions.dict = dictCursor.revision
    center.revisions.setting = settingCursor.revision
    void meta
    // 服务端文档已由 store.init() 读入，这里只需要对齐游标（避免重复拉全量）
    snapshotSetting()
    await flushAll()
    await pullAll()
    await refreshPendingCount()
    center.ready = true
    runtimeStore.syncState = 'online'
    runtimeStore.deviceId = getDeviceId()
  }

  /** 应用一次 setting.patch（供 useInit 的 $subscribe 调用） */
  async function flushSettingPatch(): Promise<void> {
    const patch = await collectSettingPatch()
    if (!Object.keys(patch).length) return
    await dispatch('setting.patch', patch)
  }

  /** 供整文档写入（首次初始化 / 导入）后登记，避免自触发重载 */
  function ignoreDocReplaceRevision(scope: OpsScope, revision: number) {
    if (revision) ignoredDocReplace.set(scope, revision)
  }

  /**
   * 整文档写入：用于**无法用操作表达的大块写入**（导入词库、批量结构变更）。
   *
   * 与「$subscribe 全量覆盖」的本质区别：这是一次显式的、用户发起的高权限写操作，
   * 服务端会计一条 `doc.replace` 并广播，其它端据此全量重载或产生冲突，
   * 而不是在一次普通练习保存里顺手把别人的写入抹掉。
   */
  async function pushWholeDocument(scope: OpsScope, label = 'bulk-write'): Promise<boolean> {
    const version = scope === 'setting' ? SAVE_SETTING_KEY.version : SAVE_DICT_KEY.version
    const envelope = {
      val: scope === 'setting' ? settingStore.$state : shakeCommonDict(store.$state as any),
      version,
      updated_at: new Date().toISOString(),
    }
    const raw = JSON.stringify(envelope)
    const saved = await saveStoreValue(scope, raw, { origin: 'import', label })
    if (saved.ok) {
      if (saved.revision) {
        ignoreDocReplaceRevision(scope, saved.revision)
        center.revisions[scope] = saved.revision
        await writeScopeCursor(scope, { revision: saved.revision, lastSyncedAt: Date.now() })
      }
      await writeShadow(scope, raw)
      markBaseline(scope)
    }
    return saved.ok
  }

  function setRevision(scope: OpsScope, revision: number) {
    center.revisions[scope] = Number(revision) || 0
  }

  /**
   * 登记「整文档写入」：推进本地游标并记住该 revision，
   * 这样既不会因为自己写的 `doc.replace` 触发全量重载，也不会让后续操作以过期基准提交。
   */
  function noteDocumentWrite(scope: OpsScope, revision: number) {
    if (!revision) return
    ignoreDocReplaceRevision(scope, revision)
    center.revisions[scope] = Number(revision) || center.revisions[scope]
    void writeScopeCursor(scope, { revision: center.revisions[scope], lastSyncedAt: Date.now() })
  }

  // 注册写入桥：让 store / 交互层在无循环依赖的前提下提交操作
  registerOpsBridge({ dispatch, dispatchMany, fingerprint, noteDocumentWrite })

  return {
    state: center,
    init,
    dispatch,
    dispatchMany,
    flush,
    flushAll,
    pull,
    pullAll,
    schedulePull,
    subscribe,
    unsubscribe: () => unsubscribe?.(),
    hardReload,
    resolveConflicts,
    decideConflicts,
    flushSettingPatch,
    snapshotSetting,
    ignoreDocReplaceRevision,
    setRevision,
    noteDocumentWrite,
    pushWholeDocument,
    writeShadowFromLocal,
    get revision() {
      return center.revisions
    },
    // 兼容命名：给「练习缓存」等场景一个显式的可用性判断
    isOffline: () => runtimeStore.syncState === 'offline',
    APP_VERSION_KEY: APP_VERSION.key,
  }
}
