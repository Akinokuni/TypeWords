import { setStoreValue } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const value = typeof body?.value === 'string' ? body.value : ''
  if (!value) {
    throw createError({ statusCode: 400, statusMessage: 'missing value' })
  }
  setStoreValue('dict', value)
  return { ok: true }
})
