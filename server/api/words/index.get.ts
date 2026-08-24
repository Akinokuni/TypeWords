import { getDictVal, findWordDict, findWord, summarizeWord, WORD_COLLECT, WORD_WRONG, WORD_KNOWN } from '../../utils/state'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const filter = String(query?.filter ?? '')
  const dictVal = getDictVal()
  if (!dictVal) return { items: [], total: 0 }
  let items: any[] = []
  if (filter === 'known') {
    items = findWordDict(dictVal, WORD_KNOWN)?.words ?? []
  } else if (filter === 'wrong') {
    items = findWordDict(dictVal, WORD_WRONG)?.words ?? []
  } else if (filter === 'collect') {
    items = findWordDict(dictVal, WORD_COLLECT)?.words ?? []
  } else if (filter === 'due') {
    const fsrs = dictVal.fsrsData ?? {}
    const now = Date.now()
    items = Object.entries(fsrs)
      .filter(([, c]: any) => new Date(c?.due).getTime() <= now)
      .map(([word, card]: any) => {
        const full = findWord(dictVal, word)
        return {
          word,
          due: card?.due,
          state: card?.state,
          phonetic0: full?.phonetic0 ?? '',
          phonetic1: full?.phonetic1 ?? '',
          trans: (full?.trans ?? []).slice(0, 5).map((t: any) => ({ pos: t?.pos ?? '', cn: t?.cn ?? '' })),
          note: dictVal.noteData?.[word] ?? '',
        }
      })
  } else {
    throw createError({ statusCode: 400, statusMessage: 'filter required: known|wrong|collect|due' })
  }
  const limit = Number(query?.limit) || 100
  const offset = Number(query?.offset) || 0
  const total = items.length
  const paged = items.slice(offset, offset + limit).map((w: any) => (filter === 'due' ? w : summarizeWord(w)))
  return { items: paged, total }
})
