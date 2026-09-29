import { replaceDocument } from '../../utils/commitOps'
import { publishOps } from '../../utils/opsChannel'

/**
 * PUT /api/data/setting —— 整文档写入（仅用于首次初始化与显式导入）。
 * 设置项的日常修改走 `POST /api/ops` 的 `setting.patch`。
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
  const revision = replaceDocument('setting', envelope, origin, String(body?.label ?? ''))
  publishOps('setting', revision, [])
  return { ok: true, revision }
})
