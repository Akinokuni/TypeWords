export default defineEventHandler((event) => {
  const token = process.env.API_TOKEN
  if (!token) return
  const path = event.path ?? ''
  if (!path.startsWith('/api')) return
  if (path === '/api/health' || path.startsWith('/api/data/')) return
  const auth = getHeader(event, 'authorization') ?? ''
  if (auth !== 'Bearer ' + token && auth !== token) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
