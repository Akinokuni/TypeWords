import { nanoid } from 'nanoid'
import { commitOperations } from '../../../utils/commitOps'
import { publishOps } from '../../../utils/opsChannel'
import { getRevision } from '../../../utils/db'
import { decodeParam, findWord, findWordDict, getDictVal, WORD_KNOWN } from '../../../utils/state'

/**
 * POST /api/words/:word/known —— 标记 / 取消「已掌握」。
 *
 * 对外语义：不传 `value` 时按当前状态取反（toggle）。
 * 内部提交一个 `word.known.set` 操作，与浏览器端共用同一份 reducer，因此两端行为一致。
 *
 * 返回体含 `changed` 与 `revision`：前者表示本次是否真的产生变更，
 * 后者可用于乐观并发与增量同步。
 */
export default defineEventHandler(async (event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const body = await readBody(event).catch(() => ({}))
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })
  const known = findWordDict(dictVal, WORD_KNOWN)
  if (!known) throw createError({ statusCode: 500, statusMessage: 'known dict missing' })

  const w = word.toLowerCase()
  const isKnown = (known.words ?? []).some((x: any) => String(x?.word).toLowerCase() === w)
  const value = body?.value === undefined ? !isKnown : !!body.value
  const full = body?.full ?? findWord(dictVal, word) ?? undefined

  const result = commitOperations('dict', [
    {
      opId: typeof body?.opId === 'string' && body.opId ? body.opId : nanoid(),
      kind: 'word.known.set',
      payload: { word, value, ...(full ? { full } : {}) },
      clientTs: new Date().toISOString(),
      baseRevision: getRevision(),
      origin: 'agent',
      entityKeys: ['word:' + w],
    },
  ])

  const conflict = result.conflicts[0]
  if (conflict) throw createError({ statusCode: 409, statusMessage: 'conflict', data: conflict })

  const applied = result.applied[0]
  if (applied?.changed) publishOps('dict', result.revision, [])
  return { word, known: value, changed: !!applied?.changed, revision: result.revision }
})
