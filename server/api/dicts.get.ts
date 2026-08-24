import { getDictVal } from '../utils/state'

export default defineEventHandler(() => {
  const dictVal = getDictVal()
  const books = dictVal?.word?.bookList ?? []
  const items = books.map((d: any) => ({
    id: d?.id ?? d?.enName,
    enName: d?.enName,
    name: d?.name,
    description: d?.description,
    length: d?.length,
    lastLearnIndex: d?.lastLearnIndex,
    perDayStudyNumber: d?.perDayStudyNumber,
    complete: d?.complete,
    custom: d?.custom,
    system: d?.system,
    category: d?.category,
    language: d?.language,
    wordCount: d?.words?.length ?? 0,
    progress: d?.length ? Math.round((d?.lastLearnIndex / d?.length) * 100) : 0,
  }))
  return { items, total: items.length }
})
