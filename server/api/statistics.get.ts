import { getDictVal } from '../utils/state'

export default defineEventHandler(() => {
  const dictVal = getDictVal()
  const books = dictVal?.word?.bookList ?? []
  const all = books.flatMap((d: any) => d?.statistics ?? [])
  const totals = {
    spendMs: all.reduce((s: number, st: any) => s + (Number(st?.spend) || 0), 0),
    wrong: all.reduce((s: number, st: any) => s + (Number(st?.wrong) || 0), 0),
    new: all.reduce((s: number, st: any) => s + (Number(st?.new) || 0), 0),
    review: all.reduce((s: number, st: any) => s + (Number(st?.review) || 0), 0),
    total: all.reduce((s: number, st: any) => s + (Number(st?.total) || 0), 0),
    sessions: all.length,
  }
  const byDay: Record<string, any> = {}
  for (const st of all) {
    const d = new Date(Number(st?.startDate))
    if (Number.isNaN(d.getTime())) continue
    const key = d.toISOString().slice(0, 10)
    if (!byDay[key]) byDay[key] = { date: key, spendMs: 0, wrong: 0, new: 0, review: 0, total: 0, sessions: 0 }
    byDay[key].spendMs += Number(st?.spend) || 0
    byDay[key].wrong += Number(st?.wrong) || 0
    byDay[key].new += Number(st?.new) || 0
    byDay[key].review += Number(st?.review) || 0
    byDay[key].total += Number(st?.total) || 0
    byDay[key].sessions += 1
  }
  return { totals, daily: Object.values(byDay) }
})
