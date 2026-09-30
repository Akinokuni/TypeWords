/**
 * GET /api/ops?since=<revision> —— 增量拉取操作日志（解决「服务端 → 浏览器」缺少通道的问题）。
 *
 * resp: { revision, mode: 'ops' | 'snapshot-required', ops: LoggedOperation[] }
 * 落后超过 OPS_LOG_LIMIT 条时返回 `snapshot-required`，调用方应转为全量重载。
 */
import { readOpsSince } from '../utils/commitOps'
import { sendCompressed } from '../utils/compress'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const since = Number(query.since ?? 0)
  return sendCompressed(event, readOpsSince(Number.isFinite(since) ? since : 0))
})
