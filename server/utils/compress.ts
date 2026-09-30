import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'

/**
 * 大文档接口的响应压缩。
 *
 * Nitro 的 `compressPublicAssets` 只预压缩 `public/` 下的静态文件，
 * 事件处理器返回的响应不经过该流程。词库文档（`/api/data/dict`）序列化后可达数 MB，
 * 未压缩时构成首屏加载的主要耗时，因此在返回前按 `Accept-Encoding` 主动压缩。
 *
 * 响应体是与编码无关的同一份 JSON 文本；内容协商结果只影响传输编码，
 * 客户端解析出的对象完全一致。
 */

export type ContentEncoding = 'br' | 'gzip'

/** 小于该长度的响应压缩收益不足 */
const MIN_COMPRESS_BYTES = 1024

const cache = new Map<string, Buffer>()

/**
 * 从 `Accept-Encoding` 选择可用编码。
 * `q=0` 表示客户端显式拒绝，必须尊重。
 */
export function pickContentEncoding(acceptEncoding: string | undefined): ContentEncoding | null {
  const value = (acceptEncoding ?? '').toLowerCase()
  if (!value) return null

  const qOf = (token: string): number | null => {
    const match = new RegExp(`(?:^|[,\\s])${token}\\s*(?:;\\s*q=([0-9.]+))?`).exec(value)
    if (!match) return null
    return match[1] === undefined ? 1 : Number(match[1])
  }

  const brQ = qOf('br')
  if (brQ !== null && brQ > 0) return 'br'
  const gzipQ = qOf('gzip')
  if (gzipQ !== null && gzipQ > 0) return 'gzip'
  return null
}

function encode(body: string, encoding: ContentEncoding): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(Buffer.from(body, 'utf8'), {
      params: {
        // 词库是高度重复的 JSON，中等质量已接近最优，换取更低的 CPU 占用
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(body),
      },
    })
  }
  return gzipSync(Buffer.from(body, 'utf8'), { level: 6 })
}

/**
 * 压缩缓存键：同一份文档内容 + 同一编码只压缩一次，避免每次请求重复消耗 CPU。
 * 内容变化后旧键不再被命中，容量上限保证不会无限增长。
 */
function cacheKey(body: string, encoding: ContentEncoding): string {
  return `${encoding}:${body.length}:${body.slice(0, 96)}:${body.slice(-96)}`
}

/**
 * 按指定编码压缩文本，返回**始终已压缩**的字节。
 *
 * 调用方一旦声明了 `Content-Encoding`，响应体就必须真的是该编码的数据，
 * 因此这里不做「太小就不压缩」的短路——是否压缩由 `sendCompressed` 在设置响应头之前决定。
 */
export function compressString(body: string, encoding: ContentEncoding): Buffer {
  const key = cacheKey(body, encoding)
  const hit = cache.get(key)
  if (hit) return hit
  const packed = encode(body, encoding)
  if (cache.size > 8) cache.clear()
  cache.set(key, packed)
  return packed
}

/**
 * 按 `Accept-Encoding` 压缩响应体并设置相应响应头，返回可直接作为事件处理器结果的值。
 *
 * 客户端不支持压缩、或响应小到压缩无收益时，返回原始对象由运行时按普通 JSON 序列化，
 * 因此调用方无需区分分支：`return sendCompressed(event, payload)` 在两种情况下都正确。
 */
export function sendCompressed(event: any, payload: unknown): any {
  const encoding = pickContentEncoding(getHeader(event, 'accept-encoding'))
  if (!encoding) return payload

  const body = JSON.stringify(payload)
  // 小响应压缩收益不足，且会白占 CPU，直接走普通路径
  if (Buffer.byteLength(body) < MIN_COMPRESS_BYTES) return payload

  const packed = compressString(body, encoding)

  setHeader(event, 'content-type', 'application/json; charset=utf-8')
  setHeader(event, 'content-encoding', encoding)
  // 编码随请求头变化，必须声明，否则中间缓存可能把 brotli 响应发给只支持 gzip 的客户端
  setHeader(event, 'vary', 'Accept-Encoding')
  setHeader(event, 'content-length', packed.length)
  // 文档内容由 revision 与 updated_at 界定，禁止中间层长期缓存，避免读到过期词库
  setHeader(event, 'cache-control', 'no-store')

  return packed
}