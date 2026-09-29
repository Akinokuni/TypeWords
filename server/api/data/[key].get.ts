import { getStoreRow } from '../../utils/db'
import { isPracticeStoreKey } from '../../utils/storeKeys'

/**
 * GET /api/data/:key —— 练习会话缓存的服务器备份读取。
 *
 * 返回 `{ value, updatedAt }`。客户端用信封里的 `updated_at` 做 LWW 比较
 * （练习会话是整快照语义，不存在有意义的合并，只有「哪次练习更靠后」）。
 * `value === null` 表示服务端确实没有备份；请求失败会以非 2xx 返回。
 */
export default defineEventHandler((event) => {
  const key = String(getRouterParam(event, 'key') ?? '')
  if (!isPracticeStoreKey(key)) {
    throw createError({ statusCode: 404, statusMessage: 'unknown store key' })
  }
  const row = getStoreRow(key)
  if (!row) return { value: null, updatedAt: null }
  return { value: row.value, updatedAt: row.updated_at }
})
