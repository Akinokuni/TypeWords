/**
 * 可选 API_TOKEN 校验。
 *
 * 安全边界：
 * - `/api/health`、`/api/data/*`、`/api/ops*` 是**浏览器前端内部接口**，不校验 token
 *   （浏览器端拿不到 token，且这些接口是应用运行所必需）。
 * - 其余 `/api/*`（Agent / 管理接口）在设置了 API_TOKEN 时要求 Bearer token。
 *
 * 前提：本应用按单机 / 内网部署。**不要直接把服务暴露到公网**，否则任何人都能读写学习数据。
 */
export default defineEventHandler((event) => {
  const token = process.env.API_TOKEN
  if (!token) return
  const path = event.path ?? ''
  if (!path.startsWith('/api')) return
  if (path === '/api/health' || path.startsWith('/api/data/') || path === '/api/ops' || path.startsWith('/api/ops/')) {
    return
  }
  const auth = getHeader(event, 'authorization') ?? ''
  if (auth !== 'Bearer ' + token && auth !== token) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
