import { getDictVal, findWord, findWordDict, decodeParam, WORD_COLLECT, WORD_WRONG, WORD_KNOWN } from '../../../utils/state'

export default defineEventHandler((event) => {
  const word = decodeParam(String(getRouterParam(event, 'word') ?? ''))
  const dictVal = getDictVal()
  if (!dictVal) throw createError({ statusCode: 404, statusMessage: 'no data' })
  const full = findWord(dictVal, word)
  const w = word.toLowerCase()
  const has = (id: string) => (findWordDict(dictVal, id)?.words ?? []).some((x: any) => String(x?.word).toLowerCase() === w)
  const fsrsEntry = Object.entries(dictVal.fsrsData ?? {}).find(([k]) => String(k).toLowerCase() === w) as [string, any] | undefined
  const noteEntry = Object.entries(dictVal.noteData ?? {}).find(([k]) => String(k).toLowerCase() === w)
  return {
    word: full?.word ?? word,
    found: !!full,
    phonetic0: full?.phonetic0 ?? '',
    phonetic1: full?.phonetic1 ?? '',
    trans: full?.trans ?? [],
    sentences: full?.sentences ?? [],
    phrases: full?.phrases ?? [],
    flags: { known: has(WORD_KNOWN), wrong: has(WORD_WRONG), collect: has(WORD_COLLECT) },
    fsrs: fsrsEntry ? { word: fsrsEntry[0], due: fsrsEntry[1]?.due, state: fsrsEntry[1]?.state } : null,
    note: noteEntry ? noteEntry[1] : '',
  }
})
