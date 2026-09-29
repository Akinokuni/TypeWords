/**
 * 离线支撑：影子副本（最后一次成功读到的服务端文档）+ 操作队列（outbox）+ 同步游标。
 *
 * 全部使用 `idb-keyval` 落 IndexedDB：
 * - 影子副本让断网或后端不可达时仍能启动。
 * - outbox 先把操作落队列再发请求，断电、崩溃、强杀标签页都不会丢操作。
 * - 同步游标记录每个 scope 已知的 revision，用于增量拉取与乐观并发。
 */
import { get, set } from 'idb-keyval'
import type { Operation } from '#shared/types/ops'

const OUTBOX_KEY = 'typewords-outbox'
const SYNC_META_KEY = 'typewords-sync-meta'
const DEVICE_KEY = 'typewords-device-id'
const SHADOW_PREFIX = 'typewords-shadow-'

export interface ScopeCursor {
  revision: number
  updatedAt?: string | null
  lastSyncedAt?: number
}

export interface SyncMetaState {
  deviceId: string
  scopes: Record<string, ScopeCursor>
}

/** 可以就地折叠的操作：同一实体上只保留最后一次意图，避免离线期间队列无限膨胀 */
const FOLDABLE_KINDS = new Set<string>([
  'word.known.set',
  'word.collect.set',
  'word.note.set',
  'word.fsrs.set',
  'dict.progress.set',
  'dict.config.set',
  'dict.meta.set',
  'setting.patch',
  'study.index.set',
])

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

/** 稳定的设备标识：用于 LWW 平局打破与审计 */
export function getDeviceId(): string {
  const fallback = () => 'dev-' + Math.random().toString(36).slice(2, 12)
  if (!canUseLocalStorage()) return fallback()
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : fallback()
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch {
    return fallback()
  }
}

/* ───────────────────────────── 影子副本 ───────────────────────────── */

export async function writeShadow(scope: string, raw: string): Promise<void> {
  try {
    await set(SHADOW_PREFIX + scope, raw)
  } catch (error) {
    console.warn('[offlineOutbox] writeShadow failed', error)
  }
}

export async function readShadow(scope: string): Promise<string | null> {
  try {
    const raw = (await get(SHADOW_PREFIX + scope)) as string | undefined
    return raw ?? null
  } catch {
    return null
  }
}

/* ───────────────────────────── 操作队列 ───────────────────────────── */

export async function readOutbox(): Promise<Operation[]> {
  try {
    const queue = (await get(OUTBOX_KEY)) as Operation[] | undefined
    return Array.isArray(queue) ? queue : []
  } catch {
    return []
  }
}

async function writeOutbox(queue: Operation[]): Promise<void> {
  try {
    await set(OUTBOX_KEY, queue)
  } catch (error) {
    console.warn('[offlineOutbox] writeOutbox failed', error)
  }
}

function foldKey(op: Operation): string {
  const entity = [...(op.entityKeys ?? [])].sort().join(',')
  return op.kind + '|' + entity
}

/** 入队。同一实体的可折叠操作就地替换，保证队列有界且语义为「最后一次意图」 */
export async function enqueue(op: Operation): Promise<void> {
  await enqueueMany([op])
}

export async function enqueueMany(ops: Operation[]): Promise<void> {
  if (!ops.length) return
  const queue = await readOutbox()
  for (const op of ops) {
    if (FOLDABLE_KINDS.has(op.kind)) {
      const key = foldKey(op)
      const idx = queue.findIndex(item => foldKey(item) === key)
      if (idx !== -1) {
        // 保留原位置（顺序即意图顺序），仅替换为最新意图
        queue[idx] = op
        continue
      }
    }
    queue.push(op)
  }
  await writeOutbox(queue)
}

export async function removeApplied(opIds: string[]): Promise<void> {
  if (!opIds.length) return
  const done = new Set(opIds)
  const queue = await readOutbox()
  await writeOutbox(queue.filter(op => !done.has(op.opId)))
}

export async function replaceOutbox(queue: Operation[]): Promise<void> {
  await writeOutbox(queue)
}

export async function outboxSize(): Promise<number> {
  return (await readOutbox()).length
}

export async function clearOutbox(): Promise<void> {
  await writeOutbox([])
}

/* ───────────────────────────── 同步游标 ───────────────────────────── */

export async function readSyncMeta(): Promise<SyncMetaState> {
  const fallback: SyncMetaState = { deviceId: getDeviceId(), scopes: {} }
  try {
    const meta = (await get(SYNC_META_KEY)) as SyncMetaState | undefined
    if (!meta || typeof meta !== 'object') return fallback
    return {
      deviceId: meta.deviceId || fallback.deviceId,
      scopes: meta.scopes && typeof meta.scopes === 'object' ? meta.scopes : {},
    }
  } catch {
    return fallback
  }
}

export async function writeSyncMeta(meta: SyncMetaState): Promise<void> {
  try {
    await set(SYNC_META_KEY, meta)
  } catch (error) {
    console.warn('[offlineOutbox] writeSyncMeta failed', error)
  }
}

export async function readScopeCursor(scope: string): Promise<ScopeCursor> {
  const meta = await readSyncMeta()
  const cursor = meta.scopes?.[scope]
  return {
    revision: Number(cursor?.revision) || 0,
    updatedAt: cursor?.updatedAt ?? null,
    lastSyncedAt: cursor?.lastSyncedAt,
  }
}

export async function writeScopeCursor(scope: string, cursor: Partial<ScopeCursor>): Promise<void> {
  const meta = await readSyncMeta()
  const prev = meta.scopes?.[scope] ?? { revision: 0 }
  meta.scopes = {
    ...meta.scopes,
    [scope]: {
      revision: cursor.revision !== undefined ? cursor.revision : prev.revision,
      updatedAt: cursor.updatedAt !== undefined ? cursor.updatedAt : prev.updatedAt,
      lastSyncedAt: cursor.lastSyncedAt !== undefined ? cursor.lastSyncedAt : prev.lastSyncedAt,
    },
  }
  await writeSyncMeta(meta)
}
