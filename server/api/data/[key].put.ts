import { getStoreRow, setStoreValue } from '../../utils/db'
import { bumpPracticeSession } from '../../utils/commitOps'
import { publishOps } from '../../utils/opsChannel'
import { isPracticeStoreKey } from '../../utils/storeKeys'

/**
 * PUT /api/data/:key —— 练习会话缓存的服务器备份写入（LWW）。
 *
 * 与其它写入不同，练习缓存不进操作日志的 payload（快照太大），
 * 而是：① 按信封的 `updated_at` 做 LWW，服务端较新则拒绝旧快照；
 * ② 递增 revision 并广播一条轻量 `practice.session.set` 通知，让其它浏览器端重新拉取。
 */
export default defineEventHandler(async (event) => {
  const key = String(getRouterParam(event, 'key') ?? '')
  if (!isPracticeStoreKey(key)) {
    throw createError({ statusCode: 404, statusMessage: 'unknown store key' })
  }
  const body = await readBody(event)
  const value = typeof body?.value === 'string' ? body.value : ''
  if (!value) {
    throw createError({ statusCode: 400, statusMessage: 'missing value' })
  }

  let incoming: any
  try {
    incoming = JSON.parse(value)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'value must be a JSON document' })
  }

  const row = getStoreRow(key)
  if (row) {
    // 内容完全相同：直接视为「无变化」，不推进 revision、不广播。
    // 练习缓存会在静止 / 定时 / 离开 / 保存后反复上传，重复广播会让所有端白白重新拉取。
    if (row.value === value) {
      return { ok: true, applied: false, updatedAt: row.updated_at }
    }
    let stored: any = null
    try {
      stored = JSON.parse(row.value)
    } catch {
      stored = null
    }
    const storedTs = Date.parse(stored?.updated_at ?? row.updated_at) || 0
    const incomingTs = Date.parse(incoming?.updated_at ?? '') || 0
    // 服务端更新则拒绝旧快照：避免较旧的练习进度覆盖较新的进度
    if (storedTs && incomingTs && incomingTs < storedTs) {
      return { ok: true, applied: false, updatedAt: stored?.updated_at ?? row.updated_at }
    }
  }

  const updatedAt = typeof incoming?.updated_at === 'string' ? incoming.updated_at : new Date().toISOString()
  setStoreValue(key, value)
  const revision = bumpPracticeSession(key, updatedAt)
  publishOps('practice', revision, [])
  return { ok: true, applied: true, revision, updatedAt }
})
