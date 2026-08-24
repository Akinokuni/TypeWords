import { getDictVal, writeState, decodeParam } from '../../../utils/state'

export default defineEventHandler(async (event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const body = await readBody(event).catch(() => ({}))
  const note = typeof body?.note === 'string' ? body.note : ''
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })
  if (!dictVal.noteData) dictVal.noteData = {}
  const key = Object.keys(dictVal.noteData).find((k) => String(k).toLowerCase() === word.toLowerCase()) ?? word
  if (note.trim() === '') {
    delete dictVal.noteData[key]
  } else {
    dictVal.noteData[key] = note
  }
  writeState('dict', dictVal)
  return { word, note: note.trim() === '' ? '' : note }
})
