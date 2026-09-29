import { replaceDocument } from '../../utils/commitOps'
import { publishOps } from '../../utils/opsChannel'

/**
 * PUT /api/data/dict —— 整文档写入（仅用于「服务端确认无数据时的首次初始化」与显式导入）。
 *
 * 正常的学习进度写入必须走 `POST /api/ops`（按实体的乐观并发 + 操作日志），
 * 全量覆盖是权限最高的写操作，会递增 revision 并广播 `doc.replace`，
 * 其它客户端收到后必须走全量重载。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const value = typeof body?.value === 'string' ? body.value : ''
  if (!value) {
    throw createError({ statusCode: 400, statusMessage: 'missing value' })
  }
  let envelope: any
  try {
    envelope = JSON.parse(value)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'value must be a JSON document' })
  }
  const origin = body?.origin === 'import' ? 'import' : 'browser'
  const revision = replaceDocument('dict', envelope, origin, String(body?.label ?? ''))
  publishOps('dict', revision, [])
  return { ok: true, revision }
})
