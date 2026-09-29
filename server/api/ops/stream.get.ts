/**
 * GET /api/ops/stream —— SSE 反向通道。
 * 只推送「有新操作」的通知（含心跳），客户端收到后按 revision 拉增量。
 */
import { createEventStream } from 'h3'
import { registerStream } from '../../utils/opsChannel'

/** 心跳间隔：避免反向代理掐断空闲连接 */
const HEARTBEAT_MS = 25_000

export default defineEventHandler(async (event) => {
  const stream = createEventStream(event)
  registerStream(stream)

  const timer = setInterval(() => {
    stream.push('ping').catch(() => {
      clearInterval(timer)
    })
  }, HEARTBEAT_MS)

  stream.onClosed(() => clearInterval(timer))

  return stream.send()
})
