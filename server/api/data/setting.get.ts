import { getStoreRow } from '../../utils/db'
import { sendCompressed } from '../../utils/compress'

/**
 * GET /api/data/setting
 * 返回 `{ value, revision, updatedAt }`；`value === null` 表示服务端确实没有数据。
 */
export default defineEventHandler((event) => {
  const row = getStoreRow('setting')
  if (!row) return { value: null, revision: 0, updatedAt: null }
  let revision = 0
  try {
    revision = Number(JSON.parse(row.value)?.revision) || 0
  } catch {
    revision = 0
  }
  return sendCompressed(event, { value: row.value, revision, updatedAt: row.updated_at })
})
