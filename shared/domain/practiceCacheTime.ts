/**
 * 练习快照「远端是否更新」的判定。
 *
 * 放在 `shared/` 是因为它是纯函数：不依赖 Vue、Nitro 或浏览器 API，
 * 因此可以被 `node:test` 直接导入验证（应用层的 `cache.ts` 依赖枚举与 IndexedDB，
 * 无法在纯 Node 环境下加载）。
 */

/** 只描述判定所需的字段，避免依赖应用层的完整类型 */
export interface PracticeCacheEnvelopeMeta {
  /** 信封的版本字段，由写入方（`utils/cache.ts` 的 `setLocal`）写入 */
  version?: number
  /** 历史字段名。服务端存储层早期用它表示同一含义，这里一并接受 */
  data_version?: number
  updated_at?: string
}

/**
 * 远端快照来自更高版本时抛出。
 *
 * 由调用方捕获并提示用户升级，而不是静默按旧版本处理。
 */
export class UnsupportedPracticeCacheVersionError extends Error {
  readonly version: number

  constructor(version: number) {
    super(`UNSUPPORTED_PRACTICE_CACHE_VERSION:${version}`)
    this.version = version
  }
}

/**
 * 判定远端练习快照是否比本机已知时间更新。
 *
 * - 远端版本高于 `expectedVersion`：抛 `UnsupportedPracticeCacheVersionError`
 * - 远端版本低于 `expectedVersion`：返回 null（旧格式交由调用方决定是否升级）
 * - 远端 `updated_at` 晚于 `knownUpdatedAt`：返回该时间戳；否则返回 null
 *
 * 版本字段缺失时按 `expectedVersion` 处理。若退化成常量 1，函数会因
 * `1 !== expectedVersion` 恒返回 null，导致既检不出其他设备的新进度，
 * 也漏掉「远端来自更高版本」的升级提示。
 */
export function resolveNewerRemotePracticeCacheTime(
  meta: PracticeCacheEnvelopeMeta | null,
  knownUpdatedAt: number,
  expectedVersion: number
): number | null {
  if (!meta) return null
  const version = Number(meta.version ?? meta.data_version ?? expectedVersion)
  if (version > expectedVersion) {
    throw new UnsupportedPracticeCacheVersionError(version)
  }
  if (version !== expectedVersion) return null
  const remoteUpdatedAt = Date.parse(meta.updated_at ?? '')
  return Number.isFinite(remoteUpdatedAt) && remoteUpdatedAt > knownUpdatedAt ? remoteUpdatedAt : null
}