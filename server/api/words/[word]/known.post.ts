import { getDictVal, writeState, findWord, findWordDict, decodeParam, WORD_KNOWN } from '../../../utils/state'

export default defineEventHandler(async (event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const body = await readBody(event).catch(() => ({}))
  const force = body?.value === undefined ? null : !!body.value
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })
  const known = findWordDict(dictVal, WORD_KNOWN)
  if (!known) throw createError({ statusCode: 500, statusMessage: 'known dict missing' })
  const w = word.toLowerCase()
  const idx = (known.words ?? []).findIndex((x: any) => String(x?.word).toLowerCase() === w)
  if (force === true || (force === null && idx === -1)) {
    if (idx === -1) known.words.push(findWord(dictVal, word) ?? { word })
  } else if (force === false || (force === null && idx !== -1)) {
    if (idx !== -1) known.words.splice(idx, 1)
  }
  known.length = known.words.length
  writeState('dict', dictVal)
  const isKnownNow = (known.words ?? []).some((x: any) => String(x?.word).toLowerCase() === w)
  return { word, known: isKnownNow }
})
