import { get } from 'idb-keyval'

export type StoreKey = 'dict' | 'setting' | 'practice_word' | 'practice_article' | 'practice_sentence'

/** 服务端文档/缓存的读取结果（成功） */
export interface LoadedStore {
  /** null 表示**服务端确认没有数据**（首次启动） */
  value: string | null
  /** 全局单调修订号，用于增量拉取与乐观并发 */
  revision: number
  updatedAt: string | null
}

/**
 * 读取结果。**必须**把「请求失败」与「服务端无数据」区分开：
 * 把网络异常当成空数据会让调用方按「首次启动」处理，从而用默认空状态覆盖服务端数据。
 *
 * 这里使用「单一接口 + 可选字段」而不是可辨识联合：本仓库 `strict: false`，
 * 该配置下联合收窄不可靠，可选字段更稳。
 */
export interface LoadOutcome {
  ok: boolean
  value: string | null
  revision: number
  updatedAt: string | null
  /** 仅当 ok === false 时有值 */
  error?: unknown
}

export interface LoadOrMigrateOutcome extends LoadOutcome {
  /** 是否由本地 IndexedDB 旧数据迁移而来 */
  migrated?: boolean
}

/** 写入结果：`applied === false` 表示服务端判定本地快照较旧（LWW）而未写入 */
export interface SaveResult {
  ok: boolean
  applied?: boolean
  revision?: number
  updatedAt?: string | null
  error?: unknown
}

/** 读取服务端数据，同时带回 revision（失败时 ok=false，绝不伪装成「无数据」） */
export async function fetchStoreOutcome(key: StoreKey): Promise<LoadOutcome> {
  try {
    const res = await $fetch<{ value: string | null; revision?: number; updatedAt?: string | null }>(
      '/api/data/' + key
    )
    return {
      ok: true,
      value: res?.value ?? null,
      revision: Number(res?.revision) || 0,
      updatedAt: res?.updatedAt ?? null,
    }
  } catch (error) {
    console.error('[serverStorage] fetch ' + key + ' failed', error)
    return { ok: false, value: null, revision: 0, updatedAt: null, error }
  }
}

/**
 * @deprecated 仅保留给不关心失败原因的调用方。新代码请用 `fetchStoreOutcome`，
 * 否则会重新引入「失败即无数据」的危险语义。
 */
export async function fetchStoreValue(key: StoreKey): Promise<string | null> {
  const outcome = await fetchStoreOutcome(key)
  return outcome.ok ? outcome.value : null
}

export async function saveStoreValue(
  key: StoreKey,
  value: string,
  options?: { keepalive?: boolean; origin?: string; label?: string }
): Promise<SaveResult> {
  try {
    const res = await $fetch<{ ok: boolean; applied?: boolean; revision?: number; updatedAt?: string | null }>(
      '/api/data/' + key,
      {
        method: 'PUT',
        body: { value, origin: options?.origin, label: options?.label },
        keepalive: options?.keepalive,
      }
    )
    return { ok: true, applied: res?.applied !== false, revision: res?.revision, updatedAt: res?.updatedAt ?? null }
  } catch (error) {
    console.error('[serverStorage] save ' + key + ' failed', error)
    return { ok: false, error }
  }
}

/**
 * 优先读服务端；**仅当服务端明确确认没有数据**时，才回退到 IndexedDB 里的历史数据并迁移。
 *
 * 「仅确认空才迁移」是硬约束：读失败时若回退并上传，会用陈旧的本地数据覆盖服务端数据。
 */
export async function loadOrMigrate(key: StoreKey, idbKey: string): Promise<LoadOrMigrateOutcome> {
  const outcome = await fetchStoreOutcome(key)
  if (!outcome.ok) {
    return { ok: false, value: null, revision: 0, updatedAt: null, error: outcome.error }
  }
  if (outcome.value) {
    return { ok: true, value: outcome.value, revision: outcome.revision, updatedAt: outcome.updatedAt, migrated: false }
  }

  try {
    const local = (await get(idbKey)) as string | undefined
    if (local) {
      const saved = await saveStoreValue(key, local)
      if (!saved.ok) {
        // 迁移失败也要能用本地数据把界面撑起来，但不能谎报已同步
        console.warn('[serverStorage] migrate ' + key + ' failed, 继续使用本地副本')
      }
      return { ok: true, value: local, revision: saved.revision ?? 0, updatedAt: outcome.updatedAt, migrated: true }
    }
  } catch (error) {
    console.error('[serverStorage] migrate ' + key + ' failed', error)
  }
  return { ok: true, value: null, revision: outcome.revision, updatedAt: outcome.updatedAt, migrated: false }
}
