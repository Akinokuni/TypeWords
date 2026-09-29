import { nanoid } from 'nanoid'
import { commitOperations } from '../../../utils/commitOps'
import { publishOps } from '../../../utils/opsChannel'
import { getRevision } from '../../../utils/db'
import { decodeParam, getDictVal } from '../../../utils/state'

/**
 * POST /api/words/:word/note —— 写 / 删单词笔记。
 *
 * 保留原有对外语义（空笔记即删除），内部提交 `word.note.set`。
 * note 的 key 统一小写（reducer 内处理），消除历史上两端 key 漂移的问题。
 */
export default defineEventHandler(async (event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const body = await readBody(event).catch(() => ({}))
  const note = typeof body?.note === 'string' ? body.note : ''
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })

  const result = commitOperations('dict', [
    {
      opId: typeof body?.opId === 'string' && body.opId ? body.opId : nanoid(),
      kind: 'word.note.set',
      payload: { word, note },
      clientTs: new Date().toISOString(),
      baseRevision: getRevision(),
      origin: 'agent',
      entityKeys: ['word:' + word.toLowerCase()],
    },
  ])

  const conflict = result.conflicts[0]
  if (conflict) throw createError({ statusCode: 409, statusMessage: 'conflict', data: conflict })

  const applied = result.applied[0]
  if (applied?.changed) publishOps('dict', result.revision, [])
  return { word, note: note.trim() === '' ? '' : note, changed: !!applied?.changed, revision: result.revision }
})
