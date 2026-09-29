/**
 * 写入桥：让 store / 交互层能够在**不产生循环依赖**的前提下提交操作。
 *
 * `stores/base.ts` 需要在切换词典等动作后提交 `study.index.set` 等操作，
 * 而 `useOpsSync` 又依赖 stores；直接互相 import 会形成环。
 * 于是这里只保留一个可注入的桥接口，由 `useOpsSync` 在创建时注册。
 *
 * 同时承担「开发期漏改探针」的基线记录：任何未走 dispatch 的直接写入
 * 都会让指纹漂移，`useInit` 在 dev 下会打印告警，帮助定位漏改点。
 */
import type { OperationKind } from '#shared/types/ops'

export type BridgeScope = 'dict' | 'setting'

export interface OpsBridge {
  dispatch(
    kind: OperationKind,
    payload?: Record<string, any>,
    options?: { scope?: BridgeScope; force?: boolean; immediate?: boolean }
  ): Promise<{ changed: boolean; opId: string }>
  dispatchMany(
    ops: Array<{ kind: OperationKind; payload?: Record<string, any>; force?: boolean }>,
    options?: { immediate?: boolean }
  ): Promise<void>
  /**
   * 登记一次「整文档写入」（导入 / 历史恢复 / 手动覆盖）。
   *
   * 必须调用：整文档写入会把 revision 推进并记一条实体域为 `*` 的 `doc.replace`，
   * 若同步层不知道新 revision，之后本端所有操作都会以过期基准提交并与之冲突。
   */
  noteDocumentWrite?(scope: BridgeScope, revision: number): void
  /** 昂贵的全量指纹，仅用于开发期探针 */
  fingerprint(scope: BridgeScope): string
}

let bridge: OpsBridge | null = null
const baseline: Record<string, string | undefined> = { dict: undefined, setting: undefined }

export function registerOpsBridge(value: OpsBridge): void {
  bridge = value
}

export function getOpsBridge(): OpsBridge | null {
  return bridge
}

/** 记录「此刻状态已与同步层一致」的基线 */
export function markBaseline(scope: BridgeScope): void {
  if (!bridge) return
  try {
    baseline[scope] = bridge.fingerprint(scope)
  } catch {
    baseline[scope] = undefined
  }
}

/**
 * 是否检测到「未经 dispatch 的直接写入」。
 * 探针只在 dev 下使用，命中不代表错误，而是提示存在漏改的写入点。
 */
export function checkDrift(scope: BridgeScope): boolean {
  if (!bridge) return false
  const prev = baseline[scope]
  if (prev === undefined) return false
  try {
    const current = bridge.fingerprint(scope)
    if (current === prev) return false
    baseline[scope] = current
    return true
  } catch {
    return false
  }
}

/** 提交一个操作；同步层尚未就绪时退化为本地不写入（避免在 SSR/早期阶段报错） */
export async function dispatchOp(
  kind: OperationKind,
  payload: Record<string, any> = {},
  options?: { scope?: BridgeScope; force?: boolean; immediate?: boolean }
): Promise<{ changed: boolean; opId: string }> {
  if (!bridge) return { changed: false, opId: '' }
  return bridge.dispatch(kind, payload, options)
}

export async function dispatchOps(
  ops: Array<{ kind: OperationKind; payload?: Record<string, any>; force?: boolean }>,
  options?: { immediate?: boolean }
): Promise<void> {
  if (!bridge || !ops.length) return
  await bridge.dispatchMany(ops, options)
}

/** 通知同步层「刚做了一次整文档写入」，用于推进游标并跳过自触发的全量重载 */
export function noteDocumentWrite(scope: BridgeScope, revision: number): void {
  if (!bridge?.noteDocumentWrite || !revision) return
  bridge.noteDocumentWrite(scope, revision)
}
