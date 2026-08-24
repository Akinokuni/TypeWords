import { getStoreValue, setStoreValue } from './db'

const DICT_VERSION = 4
const SETTING_VERSION = 23

export const WORD_COLLECT = 'wordCollect'
export const WORD_WRONG = 'wordWrong'
export const WORD_KNOWN = 'wordKnown'

export function readState(key: 'dict' | 'setting'): { val: any; version: number; updated_at: string } | null {
  const raw = getStoreValue(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function getDictVal(): any | null {
  return readState('dict')?.val ?? null
}

export function getSettingVal(): any | null {
  return readState('setting')?.val ?? null
}

export function writeState(key: 'dict' | 'setting', val: any): void {
  const prev = readState(key)
  const version = prev?.version ?? (key === 'dict' ? DICT_VERSION : SETTING_VERSION)
  setStoreValue(key, JSON.stringify({ val, version, updated_at: new Date().toISOString() }))
}

export function findWordDict(val: any, id: string): any | null {
  return (val?.word?.bookList ?? []).find((d: any) => String(d?.id ?? d?.enName) === id) ?? null
}

export function findWord(val: any, word: string): any | null {
  const w = String(word).toLowerCase()
  for (const d of val?.word?.bookList ?? []) {
    const found = (d?.words ?? []).find((x: any) => String(x?.word).toLowerCase() === w)
    if (found) return found
  }
  return null
}

export function summarizeWord(w: any): any | null {
  if (!w || typeof w !== 'object') return null
  return {
    word: w.word ?? '',
    phonetic0: w.phonetic0 ?? '',
    phonetic1: w.phonetic1 ?? '',
    trans: (w.trans ?? []).slice(0, 5).map((t: any) => ({ pos: t?.pos ?? '', cn: t?.cn ?? '' })),
  }
}

export function decodeParam(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}
