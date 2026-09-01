import { setStoreValue } from '../../utils/db'
import { isPracticeStoreKey } from '../../utils/storeKeys'

export default defineEventHandler(async (event) => {
  const key = String(getRouterParam(event, 'key') ?? '')
  if (!isPracticeStoreKey(key)) {
    throw createError({ statusCode: 404, statusMessage: 'unknown store key' })
  }
  const body = await readBody(event)
  const value = typeof body?.value === 'string' ? body.value : ''
  if (!value) {
    throw createError({ statusCode: 400, statusMessage: 'missing value' })
  }
  setStoreValue(key, value)
  return { ok: true }
})
