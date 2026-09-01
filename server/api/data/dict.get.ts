import { getStoreValue } from '../../utils/db'

export default defineEventHandler(() => {
  return { value: getStoreValue('dict') }
})
