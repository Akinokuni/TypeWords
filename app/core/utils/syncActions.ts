/**
 * 同步动作的便捷封装。
 *
 * 目的：让交互层一行就能提交语义明确的操作，避免到处写 `dispatchOp('dict.progress.set', {...})`
 * 这种重复且易错的字面量；所有封装最终都进入同一份 `shared/domain/applyOperation`。
 */
import { dispatchOp, dispatchOps } from './opsBridge'

type DictList = 'word' | 'article'

function validKey(key: unknown): key is string {
  return key !== undefined && key !== null && String(key) !== ''
}

/** 词书 / 书籍学习进度 */
export function syncDictProgress(
  list: DictList,
  dictKey: unknown,
  lastLearnIndex: number,
  complete?: boolean,
  force = false
): void {
  if (!validKey(dictKey) || !Number.isFinite(lastLearnIndex)) return
  void dispatchOp('dict.progress.set', { list, dictKey: String(dictKey), lastLearnIndex, complete }, { force })
}

/** 追加练习统计（append-only，按 id/内容指纹去重） */
export function syncDictStatistics(list: DictList, dictKey: unknown, entries: any[]): void {
  if (!validKey(dictKey) || !entries?.length) return
  void dispatchOp('dict.statistics.push', { list, dictKey: String(dictKey), entries })
}

/** 加入错词本 */
export function syncWrongWordAdd(word: any): void {
  const key = typeof word === 'string' ? word : word?.word
  if (!key) return
  void dispatchOp('word.wrong.add', { word: String(key), ...(typeof word === 'string' ? {} : { full: word }) })
}

/** 移出错词本 */
export function syncWrongWordRemove(word: string): void {
  if (!word) return
  void dispatchOp('word.wrong.remove', { word })
}

/** 写 / 删笔记（note 为空即删除） */
export function syncNote(word: string, note: string): void {
  if (!word) return
  void dispatchOp('word.note.set', { word, note })
}

/** 从 bookList 移除词书 / 书籍 */
export function syncDictRemove(list: DictList, dictKey: unknown): void {
  if (!validKey(dictKey)) return
  void dispatchOp('dict.remove', { list, dictKey: String(dictKey) })
}

/** 批量提交（保序、同基准） */
export function syncBatch(ops: Array<{ kind: any; payload?: any; force?: boolean }>, immediate = false): void {
  if (!ops.length) return
  void dispatchOps(ops, { immediate })
}
