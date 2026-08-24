export default defineEventHandler(() => {
  return { status: 'ok', time: new Date().toISOString() }
})
