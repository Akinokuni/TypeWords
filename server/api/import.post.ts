import { setStoreValue } from '../utils/db'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const dict = body?.dict
  const setting = body?.setting
  if (!dict && !setting) throw createError({ statusCode: 400, statusMessage: 'dict or setting required' })
  if (dict) {
    const val = dict?.val !== undefined ? dict.val : dict
    const version = dict?.version ?? 4
    setStoreValue('dict', JSON.stringify({ val, version, updated_at: new Date().toISOString() }))
  }
  if (setting) {
    const val = setting?.val !== undefined ? setting.val : setting
    const version = setting?.version ?? 23
    setStoreValue('setting', JSON.stringify({ val, version, updated_at: new Date().toISOString() }))
  }
  return { ok: true }
})
