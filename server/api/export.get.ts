import { readState } from '../utils/state'

export default defineEventHandler(() => {
  return { dict: readState('dict'), setting: readState('setting') }
})
