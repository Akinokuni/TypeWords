import { getDictVal, writeState, findWord, findWordDict, decodeParam, WORD_COLLECT } from '../../../utils/state'

export default defineEventHandler(async (event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const body = await readBody(event).catch(() => ({}))
  const force = body?.value === undefined ? null : !!body.value
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 409, statusMessage: 'no data, initialize first' })
  const collect = findWordDict(dictVal, WORD_COLLECT)
  if (!collect) throw createError({ statusCode: 500, statusMessage: 'collect dict missing' })
  const w = word.toLowerCase()
  const idx = (collect.words ?? []).findIndex((x: any) => String(x?.word).toLowerCase() === w)
  if (force === true || (force === null && idx === -1)) {
    if (idx === -1) collect.words.push(findWord(dictVal, word) ?? { word })
  } else if (force === false || (force === null && idx !== -1)) {
    if (idx !== -1) collect.words.splice(idx, 1)
  }
  collect.length = collect.words.length
  writeState('dict', dictVal)
  const isCollectNow = (collect.words ?? []).some((x: any) => String(x?.word).toLowerCase() === w)
  return { word, collect: isCollectNow }
})
