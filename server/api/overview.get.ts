import { getDictVal, getSettingVal, findWordDict, WORD_COLLECT, WORD_WRONG, WORD_KNOWN } from '../utils/state'

export default defineEventHandler(() => {
  const dictVal = getDictVal()
  if (!dictVal) return { initialized: false }
  const wordBooks = dictVal.word?.bookList ?? []
  const curIdx = Number(dictVal.word?.studyIndex ?? -1)
  const cur = curIdx >= 0 ? wordBooks[curIdx] : null
  const known = findWordDict(dictVal, WORD_KNOWN)
  const wrong = findWordDict(dictVal, WORD_WRONG)
  const collect = findWordDict(dictVal, WORD_COLLECT)
  const fsrs = dictVal.fsrsData ?? {}
  const now = Date.now()
  const fsrsDue = Object.values(fsrs).filter((c: any) => new Date(c?.due).getTime() <= now).length
  const totalSpendMs = wordBooks.reduce(
    (sum: number, d: any) => sum + (d?.statistics ?? []).reduce((s: number, st: any) => s + (Number(st?.spend) || 0), 0),
    0
  )
  const settingVal = getSettingVal()
  return {
    initialized: true,
    currentDict: cur
      ? {
          id: cur.id ?? cur.enName,
          name: cur.name,
          length: cur.length,
          lastLearnIndex: cur.lastLearnIndex,
          perDayStudyNumber: cur.perDayStudyNumber,
          complete: cur.complete,
          progress: cur.length ? Math.round((cur.lastLearnIndex / cur.length) * 100) : 0,
        }
      : null,
    counts: {
      known: known?.words?.length ?? 0,
      wrong: wrong?.words?.length ?? 0,
      collect: collect?.words?.length ?? 0,
      fsrsCards: Object.keys(fsrs).length,
      fsrsDue,
      notes: Object.keys(dictVal.noteData ?? {}).length,
    },
    study: { totalSpendMs, totalSpendMinutes: Math.round(totalSpendMs / 60000) },
    setting: settingVal
      ? { theme: settingVal.theme, wordPracticeMode: settingVal.wordPracticeMode, wordPracticeType: settingVal.wordPracticeType }
      : null,
  }
})
