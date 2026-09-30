import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { pickContentEncoding, compressString } from '../server/utils/compress.ts'

test('Accept-Encoding 协商：优先 brotli，其次 gzip', () => {
  assert.equal(pickContentEncoding('gzip, deflate, br'), 'br')
  assert.equal(pickContentEncoding('gzip, deflate'), 'gzip')
  assert.equal(pickContentEncoding('br'), 'br')
  assert.equal(pickContentEncoding('gzip'), 'gzip')
})

test('Accept-Encoding 协商：未声明或不支持时不压缩', () => {
  assert.equal(pickContentEncoding(undefined), null)
  assert.equal(pickContentEncoding(''), null)
  assert.equal(pickContentEncoding('identity'), null)
  assert.equal(pickContentEncoding('deflate'), null)
})

test('Accept-Encoding 协商：q=0 视为客户端拒绝该编码', () => {
  assert.equal(pickContentEncoding('br;q=0, gzip'), 'gzip')
  assert.equal(pickContentEncoding('br;q=0, gzip;q=0'), null)
  assert.equal(pickContentEncoding('br;q=0.5, gzip;q=1'), 'br')
})

test('压缩往返：brotli 与 gzip 都能还原出完全相同的文本', () => {
  const body = JSON.stringify({ value: JSON.stringify({ hello: '世界', list: [1, 2, 3] }), revision: 7 })
  const br = compressString(body, 'br')
  const gz = compressString(body, 'gzip')
  assert.equal(brotliDecompressSync(br).toString('utf8'), body)
  assert.equal(gunzipSync(gz).toString('utf8'), body)
})

test('压缩确实减小了大 JSON 的体积', () => {
  const body = JSON.stringify({ value: JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ word: `w${i}`, cn: '重复的中文释义' }))) })
  assert.ok(compressString(body, 'br').length < body.length / 4, 'brotli 应显著压缩')
  assert.ok(compressString(body, 'gzip').length < body.length / 3, 'gzip 应显著压缩')
})

test('compressString 始终返回真正的压缩数据（无论输入多小）', () => {
  const tiny = '{"ok":true}'
  assert.equal(brotliDecompressSync(compressString(tiny, 'br')).toString('utf8'), tiny)
  assert.equal(gunzipSync(compressString(tiny, 'gzip')).toString('utf8'), tiny)
})

test('相同内容的重复压缩结果一致（缓存命中不改变语义）', () => {
  const body = JSON.stringify({ value: 'x'.repeat(5000) })
  const first = compressString(body, 'br')
  const second = compressString(body, 'br')
  assert.equal(brotliDecompressSync(first).toString('utf8'), body)
  assert.equal(brotliDecompressSync(second).toString('utf8'), body)
})