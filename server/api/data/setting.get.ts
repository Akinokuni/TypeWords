import { getStoreRow } from '../../utils/db'
import { sendCompressed } from '../../utils/compress'

/**
 * GET /api/data/setting
 * 返回 `{ value, revision, updatedAt }`；`value === null` 表示服务端确实没有数据。
 *
 * 查询参数 `knownUpdatedAt` 携带客户端已持有的文档时间戳：
 * 与服务端一致时返回 `{ unchanged: true }` 而不返回文档正文，
 * 使刷新页面无需重新传输设置文档。时间戳不一致或未提供时返回完整文档。
 */
export default defineEventHandler((event) => {
  const row = getStoreRow('setting')
  if (!row) return { value: null, revision: 0, updatedAt: null }

  const knownUpdatedAt = String(getQuery(event).knownUpdatedAt ?? '')
  if (knownUpdatedAt && knownUpdatedAt === row.updated_at) {
    return { unchanged: true, updatedAt: row.updated_at }
  }

  let revision = 0
  try {
    revision = Number(JSON.parse(row.value)?.revision) || 0
  } catch {
    revision = 0
  }
  return sendCompressed(event, { value: row.value, revision, updatedAt: row.updated_at })
})