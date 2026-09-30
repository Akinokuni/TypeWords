import { getStoreRow } from '../../utils/db'
import { sendCompressed } from '../../utils/compress'

/**
 * GET /api/data/dict
 *
 * 返回 `{ value, revision, updatedAt }`。
 * `revision` 是全局单调修订号，客户端据此做增量拉取与乐观并发。
 * `value === null` 表示**服务端确实没有数据**；请求失败会以非 2xx 返回。
 * 调用方必须区分这两种情况：把读失败当作空数据会导致用默认值覆盖服务端数据。
 *
 * 词库文档可达数 MB，响应按 `Accept-Encoding` 压缩后下发。
 */
export default defineEventHandler(event => {
  const row = getStoreRow('dict')
  if (!row) return { value: null, revision: 0, updatedAt: null }
  let revision = 0
  try {
    revision = Number(JSON.parse(row.value)?.revision) || 0
  } catch {
    revision = 0
  }
  return sendCompressed(event, { value: row.value, revision, updatedAt: row.updated_at })
})