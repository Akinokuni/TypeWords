/**
 * 双端共享的操作（Operation）类型定义。
 *
 * 该文件位于 Nuxt 的 `shared/` 目录，会被 Vue app 与 Nitro server 同时打包，
 * 因此**不得** import Vue / Pinia / h3 / #imports（见 test/parity.test.ts 的约束断言）。
 *
 * 设计要点：
 * - 操作语义明确（「把 X 加入 known」而不是「known 现在是这个数组」），因此可幂等、可重放、可合并。
 * - `baseRevision` 是提交方看到的最后服务端修订号，服务端据此做**按实体**的乐观并发校验。
 * - `entityKeys` 由 `deriveEntityKeys()` 从 kind + payload 推导，决定冲突域。
 */

/** 运行时枚举（同时作为 OperationKind 的唯一真相，便于服务端校验） */
export const OPERATION_KINDS = [
  /** 标记 / 取消「已掌握」 */
  'word.known.set',
  /** 收藏 / 取消收藏 */
  'word.collect.set',
  /** 加入错词本 */
  'word.wrong.add',
  /** 移出错词本 */
  'word.wrong.remove',
  /** 写 / 删单词笔记 */
  'word.note.set',
  /** 更新 FSRS 卡片 */
  'word.fsrs.set',
  /** 删除 FSRS 卡片（已掌握即可移除） */
  'word.fsrs.remove',
  /** 词书学习进度（lastLearnIndex / complete） */
  'dict.progress.set',
  /** 词书配置（perDayStudyNumber 等） */
  'dict.config.set',
  /** 词书元信息（name / description / cover / custom 等） */
  'dict.meta.set',
  /** 追加练习统计 */
  'dict.statistics.push',
  /** 新增词书 / 书籍到 bookList */
  'dict.add',
  /** 从 bookList 移除词书 / 书籍 */
  'dict.remove',
  /** 替换词书 / 书籍的内容（words / articles），用于导入与编辑 */
  'dict.content.replace',
  /** 当前学习词书指针（以 key 表达，双端各自解析成索引，避免下标漂移） */
  'study.index.set',
  /** 文章收藏 */
  'article.collect.set',
  /** 设置项局部更新 */
  'setting.patch',
  /** 练习会话缓存（仅服务端产生，客户端收到后重新拉取会话快照） */
  'practice.session.set',
  /** 整文档替换（仅服务端记账：/api/data/* 与 /api/import 的全量写入） */
  'doc.replace',
] as const

export type OperationKind = (typeof OPERATION_KINDS)[number]

const KIND_SET = new Set<string>(OPERATION_KINDS)

export function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

export type OperationOrigin = 'browser' | 'agent' | 'import' | 'server'

export interface Operation<K extends OperationKind = OperationKind> {
  /** 客户端生成的幂等 ID（nanoid），服务端以唯一索引去重 */
  opId: string
  kind: K
  payload: Record<string, any>
  /** 操作产生时的本地时间（ISO），仅用于展示与 LWW 兜底，不作为权威排序依据 */
  clientTs: string
  /** 提交方看到的最后服务端修订号 */
  baseRevision: number
  /** 来源标识，便于审计与 SSE 回环过滤 */
  origin: OperationOrigin
  /** 冲突域；由 deriveEntityKeys 推导 */
  entityKeys: string[]
  /**
   * 用户在冲突弹窗中明确选择「保留本地」时置 true。
   * 仅影响带单调语义的操作（如 dict.progress.set 允许进度回退），
   * 正常重放路径不带该标记，保证离线重放安全。
   */
  force?: boolean
}

/** 服务端返回的单条应用结果 */
export interface AppliedOpResult {
  opId: string
  revision: number
  changed: boolean
}

/** 服务端返回的单条冲突 */
export interface OpConflict {
  opId: string
  kind: OperationKind | string
  reason: 'ENTITY_MODIFIED' | 'UNKNOWN_KIND' | 'INVALID_PAYLOAD'
  message?: string
  serverRevision: number
  /** 与本地操作相交的其它操作，供客户端展示与合并 */
  conflictingOps: Operation[]
}

export interface CommitResult {
  revision: number
  applied: AppliedOpResult[]
  conflicts: OpConflict[]
}

/** oplog 中一条已落库的操作（带服务端分配的 revision） */
export interface LoggedOperation extends Operation {
  revision: number
  appliedAt: string
}

export interface OpsPullResult {
  revision: number
  mode: 'ops' | 'snapshot-required'
  ops: LoggedOperation[]
}

export interface SyncMeta {
  revision: number
  updatedAt?: string
}

/** 练习缓存（整快照语义，走独立端点的 LWW，不进 oplog 的 payload） */
export type PracticeSessionScope = 'practice_word' | 'practice_article' | 'practice_sentence'
