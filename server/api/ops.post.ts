/**
 * POST /api/ops —— 浏览器端与 Agent 共用的操作提交入口。
 *
 * body: { scope: 'dict' | 'setting', ops: Operation[] }
 * resp: { revision, applied: [{ opId, revision, changed }], conflicts: [...] }
 *
 * 提交后通过 SSE 广播，通知其它浏览器端拉取增量。
 */
import { commitOperations } from '../utils/commitOps'
import { publishOps } from '../utils/opsChannel'

/** 单批最大操作数，防止一次请求写入过多 */
const MAX_BATCH = 500

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const scope = body?.scope === 'setting' ? 'setting' : 'dict'
  const ops = Array.isArray(body?.ops) ? body.ops : []
  if (!ops.length) {
    throw createError({ statusCode: 400, statusMessage: 'ops required' })
  }
  if (ops.length > MAX_BATCH) {
    throw createError({ statusCode: 413, statusMessage: `too many ops in one batch (max ${MAX_BATCH})` })
  }

  const result = commitOperations(scope, ops)
  if (result.applied.some(item => item.changed)) {
    publishOps(scope, result.revision, ops)
  }
  return result
})
