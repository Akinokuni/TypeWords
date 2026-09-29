/**
 * 服务端唯一的写入通道。
 *
 * 在单个 SQLite 事务内完成：幂等校验 → 按实体的乐观并发校验 → 应用操作
 * （调用与浏览器端**同一份** `shared/domain/applyOperation`）→ 递增 revision → 写 oplog。
 *
 * 浏览器端与 Agent 都经此函数写入，因此领域逻辑只有一份，并发写入按实体隔离，
 * 而不是整份文档互相覆盖。
 */
import { createError } from 'h3'
import { nanoid } from 'nanoid'
import { applyOperation, deriveEntityKeys, entityKeysIntersect, scopeOfOperation } from '#shared/domain/applyOperation'
import {
  isOperationKind,
  type AppliedOpResult,
  type CommitResult,
  type LoggedOperation,
  type OpConflict,
  type Operation,
  type OperationOrigin,
} from '#shared/types/ops'
import {
  getDb,
  getReplaceRevision,
  getRevision,
  getStoreRow,
  setReplaceRevision,
  setRevision,
  setStoreValueWithTime,
  withTransaction,
} from './db'

/** 单次拉取的操作条数上限；超过则让客户端走全量快照，避免重放超长日志 */
export const OPS_LOG_LIMIT = 500

/** 单条冲突最多回带多少条相交操作 */
const MAX_CONFLICT_OPS = 20

interface LogRow {
  revision: number
  op_id: string
  kind: string
  payload: string | null
  entity_keys: string
  origin: string
  client_ts: string | null
  applied_at: string
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToOperation(row: LogRow): LoggedOperation {
  return {
    opId: row.op_id,
    kind: row.kind as LoggedOperation['kind'],
    payload: parseJson<Record<string, any>>(row.payload, {}),
    clientTs: row.client_ts ?? row.applied_at,
    baseRevision: 0,
    origin: row.origin as OperationOrigin,
    entityKeys: parseJson<string[]>(row.entity_keys, []),
    revision: row.revision,
    appliedAt: row.applied_at,
  }
}

/** 校验并补全客户端提交的操作 */
function normalizeOperation(raw: any): Operation | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.opId !== 'string' || !raw.opId) return null
  if (!isOperationKind(raw.kind)) return null
  if (raw.kind === 'doc.replace' || raw.kind === 'practice.session.set') return null
  const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {}
  return {
    opId: raw.opId,
    kind: raw.kind,
    payload,
    clientTs: typeof raw.clientTs === 'string' ? raw.clientTs : new Date().toISOString(),
    baseRevision: Number.isFinite(Number(raw.baseRevision)) ? Number(raw.baseRevision) : 0,
    origin: (['browser', 'agent', 'import', 'server'] as string[]).includes(raw.origin) ? raw.origin : 'browser',
    entityKeys: Array.isArray(raw.entityKeys) && raw.entityKeys.length
      ? raw.entityKeys.map((k: unknown) => String(k))
      : deriveEntityKeys(raw.kind, payload),
    force: !!raw.force,
  }
}

/** 查询 [fromExclusive, toInclusive] 区间的日志行：本批次开始前已存在的操作 */
function selectOpsInRange(fromExclusive: number, toInclusive: number): LogRow[] {
  return getDb()
    .prepare(
      `SELECT revision, op_id, kind, payload, entity_keys, origin, client_ts, applied_at
       FROM oplog WHERE revision > ? AND revision <= ? ORDER BY revision`
    )
    .all(Math.max(0, fromExclusive), toInclusive) as unknown as LogRow[]
}

/** 找出与给定实体键相交的既有操作 */
export function findConflictingOps(fromExclusive: number, toInclusive: number, entityKeys: string[]): LoggedOperation[] {
  return selectOpsInRange(fromExclusive, toInclusive)
    .filter(row => entityKeysIntersect(parseJson<string[]>(row.entity_keys, []), entityKeys))
    .map(rowToOperation)
}

/**
 * 写入一条操作日志。
 *
 * `ON CONFLICT(op_id) DO UPDATE` 用于同一个 opId 跨越整文档替换后再次提交的场景：
 * 该行需要推进到新的 revision，而不是撞上 op_id 唯一约束。revision 单调递增，
 * 因此改写主键不会与既有行冲突。
 */
function insertLog(revision: number, op: Operation, entityKeys: string[], appliedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO oplog (revision, op_id, kind, payload, entity_keys, origin, client_ts, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(op_id) DO UPDATE SET
         revision = excluded.revision,
         kind = excluded.kind,
         payload = excluded.payload,
         entity_keys = excluded.entity_keys,
         origin = excluded.origin,
         client_ts = excluded.client_ts,
         applied_at = excluded.applied_at`
    )
    .run(
      revision,
      op.opId,
      op.kind,
      JSON.stringify(op.payload ?? {}),
      JSON.stringify(entityKeys),
      op.origin ?? 'browser',
      op.clientTs ?? appliedAt,
      appliedAt
    )
}

/**
 * 查 opId 是否**在当前文档代内**已应用。
 *
 * 判据是该操作记录的 revision 是否晚于最近一次整文档替换（见 `getReplaceRevision`）。
 */
export function findAppliedOpRevision(opId: string): number | null {
  const row = getDb().prepare('SELECT revision FROM oplog WHERE op_id = ?').get(opId) as { revision: number } | undefined
  if (!row) return null
  return row.revision > getReplaceRevision() ? row.revision : null
}

/**
 * 提交一批操作。整个批次在一个事务内完成，任何一步失败都整体回滚。
 *
 * 冲突判定粒度是「操作影响的实体键」：两个操作只要实体键不相交就不算冲突，
 * 因此「Agent 在后台批量标记单词」与「用户正在练习另一本词书」互不阻塞。
 */
export function commitOperations(stateKey: 'dict' | 'setting', ops: Operation[]): CommitResult {
  if (!Array.isArray(ops) || !ops.length) {
    return { revision: getRevision(), applied: [], conflicts: [] }
  }

  return withTransaction(() => {
    const row = getStoreRow(stateKey)
    if (!row) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })

    let doc: any
    try {
      doc = JSON.parse(row.value)
    } catch {
      throw createError({ statusCode: 500, statusMessage: 'stored document is not valid JSON' })
    }
    const state = doc?.val ?? {}

    const startRevision = getRevision()
    let revision = startRevision
    const applied: AppliedOpResult[] = []
    const conflicts: OpConflict[] = []
    let dirty = false

    const db = getDb()

    for (const raw of ops) {
      const op = normalizeOperation(raw)
      if (!op) {
        conflicts.push({
          opId: typeof raw?.opId === 'string' ? raw.opId : '',
          kind: typeof raw?.kind === 'string' ? raw.kind : '',
          reason: isOperationKind(raw?.kind) ? 'INVALID_PAYLOAD' : 'UNKNOWN_KIND',
          serverRevision: revision,
          conflictingOps: [],
        })
        continue
      }

      // scope 必须与 kind 匹配：否则会把 setting 的补丁写进 dict 文档（或反之），静默污染数据
      const expectedScope = scopeOfOperation(op.kind)
      if (expectedScope !== stateKey) {
        conflicts.push({
          opId: op.opId,
          kind: op.kind,
          reason: 'INVALID_PAYLOAD',
          message: `kind "${op.kind}" must be submitted with scope="${expectedScope}"`,
          serverRevision: revision,
          conflictingOps: [],
        })
        continue
      }

      // 幂等：同一 opId 已应用过则直接回带原 revision（离线重放 / 网络重试安全）
      const dupRevision = findAppliedOpRevision(op.opId)
      if (dupRevision !== null) {
        applied.push({ opId: op.opId, revision: dupRevision, changed: false })
        continue
      }

      const entityKeys = op.entityKeys?.length ? op.entityKeys : deriveEntityKeys(op.kind, op.payload)

      // 乐观并发：仅当同一实体在本批次开始前已被改过时才算冲突
      if (op.baseRevision < startRevision) {
        const clash = findConflictingOps(op.baseRevision, startRevision, entityKeys)
        if (clash.length) {
          conflicts.push({
            opId: op.opId,
            kind: op.kind,
            reason: 'ENTITY_MODIFIED',
            message: 'entity modified by another writer',
            serverRevision: revision,
            conflictingOps: clash.slice(-MAX_CONFLICT_OPS),
          })
          continue
        }
      }

      const { changed } = applyOperation(state, op)
      if (!changed) {
        applied.push({ opId: op.opId, revision, changed: false })
        continue
      }

      revision += 1
      insertLog(revision, op, entityKeys, new Date().toISOString())
      applied.push({ opId: op.opId, revision, changed: true })
      dirty = true
    }

    if (dirty) {
      const now = new Date().toISOString()
      setStoreValueWithTime(stateKey, JSON.stringify({ ...doc, val: state, revision, updated_at: now }), now)
      setRevision(revision)
    }

    return { revision, applied, conflicts }
  })
}

/**
 * 整文档替换（/api/data/*、/api/import 等全量写入路径）。
 * 递增 revision 并记一条 `doc.replace`，所有客户端收到 SSE 后走全量重载。
 */
export function replaceDocument(
  stateKey: string,
  envelope: any,
  origin: OperationOrigin = 'server',
  label = ''
): number {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.val === 'undefined') {
    throw createError({ statusCode: 400, statusMessage: 'document must contain "val"' })
  }
  return withTransaction(() => {
    const revision = getRevision() + 1
    const now = new Date().toISOString()
    const doc = { ...envelope, revision, updated_at: now }
    setStoreValueWithTime(stateKey, JSON.stringify(doc), now)
    insertLog(
      revision,
      {
        opId: 'srv-' + nanoid(),
        kind: 'doc.replace',
        payload: { doc: stateKey, label },
        clientTs: now,
        baseRevision: revision - 1,
        origin,
        entityKeys: ['*'],
      },
      ['*'],
      now
    )
    // 文档整体替换后进入新一代：先前记下的 opId 不能作为「已生效」的依据
    setReplaceRevision(revision)
    setRevision(revision)
    return revision
  })
}

/** 练习会话快照（大块数据）走独立通道：递增 revision + 只记一条轻量通知 */
export function bumpPracticeSession(key: string, updatedAt: string): number {
  return withTransaction(() => {
    const revision = getRevision() + 1
    const now = new Date().toISOString()
    insertLog(
      revision,
      {
        opId: 'srv-' + nanoid(),
        kind: 'practice.session.set',
        payload: { key, updatedAt },
        clientTs: now,
        baseRevision: revision - 1,
        origin: 'server',
        entityKeys: ['practice:' + key],
      },
      ['practice:' + key],
      now
    )
    setRevision(revision)
    return revision
  })
}

/** 读取 since 之后的日志；条目过多时返回 snapshot-required */
export function readOpsSince(since: number): { revision: number; mode: 'ops' | 'snapshot-required'; ops: LoggedOperation[] } {
  const revision = getRevision()
  const rows = getDb()
    .prepare(
      `SELECT revision, op_id, kind, payload, entity_keys, origin, client_ts, applied_at
       FROM oplog WHERE revision > ? ORDER BY revision LIMIT ?`
    )
    .all(Math.max(0, since), OPS_LOG_LIMIT + 1) as unknown as LogRow[]

  if (rows.length > OPS_LOG_LIMIT) {
    return { revision, mode: 'snapshot-required', ops: [] }
  }
  return { revision, mode: 'ops', ops: rows.map(rowToOperation) }
}
