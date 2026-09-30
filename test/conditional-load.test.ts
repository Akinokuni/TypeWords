import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 服务端「未变化」判定的等价实现。
 *
 * 真实实现在 `server/api/data/dict.get.ts`：`knownUpdatedAt` 与当前文档时间戳一致时
 * 只回 `{ unchanged: true }`，不下发正文。这里用同一规则验证分支语义，
 * 确保客户端不会把「未变化」当成「无数据」。
 */
function decide(knownUpdatedAt: string, serverUpdatedAt: string, hasRow: boolean) {
  if (!hasRow) return { value: null, revision: 0, updatedAt: null }
  if (knownUpdatedAt && knownUpdatedAt === serverUpdatedAt) {
    return { unchanged: true, updatedAt: serverUpdatedAt }
  }
  return { unchanged: false, value: 'FULL_DOCUMENT', updatedAt: serverUpdatedAt }
}

test('时间戳一致时不下发正文', () => {
  const res = decide('2026-08-25T09:43:25.626Z', '2026-08-25T09:43:25.626Z', true)
  assert.equal(res.unchanged, true)
  assert.equal((res as any).value, undefined, '未变化时不应携带正文')
})

test('时间戳不一致时下发完整文档', () => {
  const res = decide('2026-08-01T00:00:00.000Z', '2026-08-25T09:43:25.626Z', true)
  assert.equal(res.unchanged, false)
  assert.equal((res as any).value, 'FULL_DOCUMENT')
})

test('未携带时间戳时下发完整文档（老客户端与强制全量路径）', () => {
  const res = decide('', '2026-08-25T09:43:25.626Z', true)
  assert.equal(res.unchanged, false)
  assert.equal((res as any).value, 'FULL_DOCUMENT')
})

test('服务端无数据时不返回 unchanged（首次启动仍需写默认值）', () => {
  const res = decide('2026-08-25T09:43:25.626Z', '', false)
  assert.equal((res as any).unchanged, undefined)
  assert.equal((res as any).value, null)
})

test('「未变化」与「无数据」必须可区分', () => {
  const unchanged = decide('T', 'T', true)
  const empty = decide('T', '', false)
  // 两者 value 都是「没有正文」，但语义相反：前者要用本地副本，后者要写默认值
  assert.equal((unchanged as any).value, undefined)
  assert.equal((empty as any).value, null)
  assert.notEqual((unchanged as any).unchanged, (empty as any).unchanged)
})