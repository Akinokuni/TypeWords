import { nanoid } from 'nanoid'
import { commitOperations } from '../../../utils/commitOps'
import { publishOps } from '../../../utils/opsChannel'
import { getRevision } from '../../../utils/db'
import { decodeParam, findWord, findWordDict, getDictVal, WORD_COLLECT } from '../../../utils/state'

/**
 * POST /api/words/:word/collect —— 收藏 / 取消收藏。
 * 保留原有对外语义，内部提交 `word.collect.set`，与浏览器端共用同一 reducer。
 */
export default defineEventHandler(async (event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const body = await readBody(event).catch(() => ({}))
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })
  const collect = findWordDict(dictVal, WORD_COLLECT)
  if (!collect) throw createError({ statusCode: 500, statusMessage: 'collect dict missing' })

  const w = word.toLowerCase()
  const isCollect = (collect.words ?? []).some((x: any) => String(x?.word).toLowerCase() === w)
  const value = body?.value === undefined ? !isCollect : !!body.value
  const full = body?.full ?? findWord(dictVal, word) ?? undefined

  const result = commitOperations('dict', [
    {
      opId: typeof body?.opId === 'string' && body.opId ? body.opId : nanoid(),
      kind: 'word.collect.set',
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
  return { word, collect: value, changed: !!applied?.changed, revision: result.revision }
})
