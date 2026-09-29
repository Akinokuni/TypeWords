/**
 * SSE 广播：把服务端的新操作实时推给所有浏览器端（方案的「反向通道」）。
 * 使用 h3 内置 createEventStream，零新依赖。
 */
import type { EventStream } from 'h3'

const streams = new Set<EventStream>()

export function registerStream(stream: EventStream): void {
  streams.add(stream)
  stream.onClosed(() => {
    streams.delete(stream)
  })
}

/** 广播一条「有新操作」的通知；客户端收到后自行按 revision 拉增量，避免消息乱序 */
export function publishOps(scope: string, revision: number, ops: unknown[]): void {
  if (!streams.size) return
  const message = JSON.stringify({ scope, revision, count: ops.length })
  for (const stream of streams) {
    stream.push(message).catch(() => {
      streams.delete(stream)
    })
  }
}

export function activeStreamCount(): number {
  return streams.size
}
