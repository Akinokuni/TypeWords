import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveNewerRemotePracticeCacheTime,
  UnsupportedPracticeCacheVersionError,
} from '../shared/domain/practiceCacheTime.ts'

/** 与 app/core/utils/cache.ts 的 PRACTICE_WORD_CACHE.version 保持一致 */
const V = 2
const T = (s: string) => Date.parse(s)

test('信封用 version 字段时也能正确比较（历史 bug：只读 data_version 会恒返回 null）', () => {
  const envelope = { version: V, updated_at: '2026-09-30T12:00:00.000Z' }
  const remote = resolveNewerRemotePracticeCacheTime(envelope, T('2026-09-30T11:00:00.000Z'), V)
  assert.equal(remote, T('2026-09-30T12:00:00.000Z'), '远端更新时应返回其时间戳')
})

test('远端不比本地新时返回 null（不打扰正在进行的练习）', () => {
  const envelope = { version: V, updated_at: '2026-09-30T12:00:00.000Z' }
  assert.equal(resolveNewerRemotePracticeCacheTime(envelope, T('2026-09-30T12:00:00.000Z'), V), null)
  assert.equal(resolveNewerRemotePracticeCacheTime(envelope, T('2026-09-30T13:00:00.000Z'), V), null)
})

test('本机自己刚上传的备份不会被判成「其他设备的新进度」', () => {
  const now = T('2026-09-30T12:00:00.000Z')
  const envelope = { version: V, updated_at: '2026-09-30T12:00:00.000Z' }
  assert.equal(resolveNewerRemotePracticeCacheTime(envelope, now, V), null)
})

test('更高版本抛升级错误，交由调用方提示', () => {
  const envelope = { version: V + 1, updated_at: '2026-09-30T12:00:00.000Z' }
  assert.throws(() => resolveNewerRemotePracticeCacheTime(envelope, 0, V), UnsupportedPracticeCacheVersionError)
})

test('兼容历史的 data_version 字段名', () => {
  const envelope = { data_version: V, updated_at: '2026-09-30T12:00:00.000Z' }
  assert.equal(resolveNewerRemotePracticeCacheTime(envelope, T('2026-09-30T11:00:00.000Z'), V), T('2026-09-30T12:00:00.000Z'))
})

test('缺少版本字段时按期望版本处理，而不是退化成版本 1 而静默失效', () => {
  const envelope = { updated_at: '2026-09-30T12:00:00.000Z' }
  assert.equal(resolveNewerRemotePracticeCacheTime(envelope, T('2026-09-30T11:00:00.000Z'), V), T('2026-09-30T12:00:00.000Z'))
})

test('旧版本快照返回 null，不误报新进度', () => {
  const envelope = { version: 1, updated_at: '2026-09-30T12:00:00.000Z' }
  assert.equal(resolveNewerRemotePracticeCacheTime(envelope, 0, V), null)
})

test('信封缺失或时间戳非法时返回 null', () => {
  assert.equal(resolveNewerRemotePracticeCacheTime(null, 0, V), null)
  assert.equal(resolveNewerRemotePracticeCacheTime({ version: V }, 0, V), null)
})