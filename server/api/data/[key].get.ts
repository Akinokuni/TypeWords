import { getStoreValue } from '../../utils/db'
import { isPracticeStoreKey } from '../../utils/storeKeys'

export default defineEventHandler((event) => {
  const key = String(getRouterParam(event, 'key') ?? '')
  if (!isPracticeStoreKey(key)) {
    throw createError({ statusCode: 404, statusMessage: 'unknown store key' })
  }
  return { value: getStoreValue(key) }
})
