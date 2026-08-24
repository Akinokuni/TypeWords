import { getDictVal } from '../../../utils/state'

export default defineEventHandler((event) => {
  const id = String(getRouterParam(event, 'id') ?? '')
  const dictVal = getDictVal()
  const d = (dictVal?.word?.bookList ?? []).find((x: any) => String(x?.id ?? x?.enName) === id) ?? null
  if (!d) throw createError({ statusCode: 404, statusMessage: 'dict not found' })
  const stats = d.statistics ?? []
  return {
    id: d.id ?? d.enName,
    enName: d.enName,
    name: d.name,
    length: d.length,
    lastLearnIndex: d.lastLearnIndex,
    perDayStudyNumber: d.perDayStudyNumber,
    complete: d.complete,
    progress: d.length ? Math.round((d.lastLearnIndex / d.length) * 100) : 0,
    wordCount: d.words?.length ?? 0,
    totals: {
      spendMs: stats.reduce((s: number, st: any) => s + (Number(st?.spend) || 0), 0),
      wrong: stats.reduce((s: number, st: any) => s + (Number(st?.wrong) || 0), 0),
      new: stats.reduce((s: number, st: any) => s + (Number(st?.new) || 0), 0),
      review: stats.reduce((s: number, st: any) => s + (Number(st?.review) || 0), 0),
      total: stats.reduce((s: number, st: any) => s + (Number(st?.total) || 0), 0),
      sessions: stats.length,
    },
    statistics: stats,
  }
})
