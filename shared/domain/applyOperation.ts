/**
 * 双端唯一的状态变更入口。
 *
 * 浏览器端与 Nitro server 都通过 `applyOperation(state, op)` 修改 dict / setting 状态，
 * 因此同一个操作在两端产生同一个结果。
 *
 * 约束：
 * - 纯函数：给定 state 与 op，结果确定；不依赖时间、随机数与网络。
 * - 幂等：状态已一致时返回 changed=false，可安全重放。
 * - 不得 import Vue / Pinia / h3 / #imports（`test/sync-reducer.test.ts` 有断言）。
 */
import type { Operation, OperationKind, OperationOrigin } from '../types/ops'

export type WordListName = 'word' | 'article'

/** 操作作用的文档：绝大多数操作属于 `dict`，只有 setting.patch 属于 `setting` */
export type OpsScope = 'dict' | 'setting'

/**
 * 操作 → 目标文档 的唯一映射，双端共用。
 *
 * 服务端据此校验请求里的 `scope` 是否与 `kind` 匹配：
 * 若把 `setting.patch` 用 `scope: "dict"` 提交，会被拒绝而不是写进 dict 文档。
 */
export function scopeOfOperation(kind: OperationKind | string): OpsScope {
  return kind === 'setting.patch' ? 'setting' : 'dict'
}

export const SYSTEM_DICT_IDS = {
  known: 'wordKnown',
  collect: 'wordCollect',
  wrong: 'wordWrong',
  articleCollect: 'articleCollect',
} as const

/** 与前端 getter 对齐的词典标识集合（id / enName / en_name 任一匹配） */
export function dictIdentityList(dict: any): string[] {
  if (!dict) return []
  return Array.from(
    new Set(
      [dict.id, dict.enName, dict.en_name]
        .filter(v => v !== undefined && v !== null && v !== '')
        .map(v => String(v))
    )
  )
}

/** 统一的词书定位逻辑，消除两端匹配优先级不一致的问题 */
export function findDictByKey(state: any, list: WordListName, key: unknown): any | null {
  const target = key === undefined || key === null ? '' : String(key)
  if (!target) return null
  const bookList = state?.[list]?.bookList ?? []
  return bookList.find((d: any) => dictIdentityList(d).includes(target)) ?? null
}

/** 按固定 id 找系统虚拟词典（收藏 / 错词 / 已掌握 / 文章收藏） */
export function findSystemDict(state: any, list: WordListName, keys: string[]): any | null {
  const bookList = state?.[list]?.bookList ?? []
  return bookList.find((d: any) => dictIdentityList(d).some(id => keys.includes(id))) ?? null
}

/** 统一的单词查找（全词书范围，含文章新词），返回完整 Word 对象 */
export function findFullWord(state: any, word: unknown): any | null {
  const w = String(word ?? '').toLowerCase()
  if (!w) return null
  for (const list of ['word', 'article'] as WordListName[]) {
    for (const dict of state?.[list]?.bookList ?? []) {
      const hit = (dict?.words ?? []).find((x: any) => String(x?.word ?? '').toLowerCase() === w)
      if (hit) return hit
      const hitNew = (dict?.newWords ?? []).find((x: any) => String(x?.word ?? '').toLowerCase() === w)
      if (hitNew) return hitNew
    }
  }
  return null
}

function sameWord(a: any, b: string): boolean {
  return String(a?.word ?? '').toLowerCase() === b
}

/**
 * 集合成员增删。状态已一致时返回 false（幂等）。
 * `full` 为完整 Word 对象；缺失时退化为 `{ word }`（历史上服务端的行为，此处显式保留）。
 */
export function setMembership(dict: any, word: string, full: any, on: boolean): boolean {
  if (!dict) return false
  if (!Array.isArray(dict.words)) dict.words = []
  const w = String(word ?? '').toLowerCase()
  if (!w) return false
  const idx = dict.words.findIndex((x: any) => sameWord(x, w))
  const has = idx !== -1
  if (on === has) return false
  if (on) dict.words.push(full ?? { word })
  else dict.words.splice(idx, 1)
  dict.length = dict.words.length
  return true
}

/** 统计条目的稳定身份：优先用显式 id，历史数据退化为内容指纹 */
export function statisticsEntryKey(entry: any): string {
  if (!entry) return ''
  if (entry.id) return String(entry.id)
  return [entry.startDate, entry.spend, entry.total, entry.new, entry.review, entry.wrong, entry.title ?? ''].join('|')
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function assignPatch(target: any, patch: any): boolean {
  if (!isPlainObject(target) || !isPlainObject(patch)) return false
  let changed = false
  for (const [k, v] of Object.entries(patch)) {
    if (target[k] !== v) {
      target[k] = v
      changed = true
    }
  }
  return changed
}

export interface ApplyResult {
  changed: boolean
  /** 变化原因，便于服务端记日志与前端调试 */
  reason?: string
}

/**
 * 唯一的状态变更入口。
 *
 * 调用方负责传入可安全修改的对象：服务端传入 JSON.parse 出来的副本，
 * 前端在 Pinia store 上就地应用（随后由 op log / SSE 收敛）。
 */
export function applyOperation(state: any, op: Operation): ApplyResult {
  if (!state || !op) return { changed: false }
  const payload = op.payload ?? {}

  switch (op.kind) {
    case 'word.known.set': {
      const { word, value, full } = payload as { word: string; value: boolean; full?: any }
      const dict = findSystemDict(state, 'word', [SYSTEM_DICT_IDS.known, 'known'])
      if (!dict) return { changed: false, reason: 'known dict missing' }
      let changed = setMembership(dict, word, full ?? findFullWord(state, word), !!value)
      // 标记为已掌握时同时移出错词本；两端共用此实现，行为不会分叉
      if (value) {
        const wrong = findSystemDict(state, 'word', [SYSTEM_DICT_IDS.wrong, 'wrong'])
        if (wrong) changed = setMembership(wrong, word, full ?? findFullWord(state, word), false) || changed
      }
      return { changed }
    }

    case 'word.collect.set': {
      const { word, value, full } = payload as { word: string; value: boolean; full?: any }
      const dict = findSystemDict(state, 'word', [SYSTEM_DICT_IDS.collect, 'collect'])
      if (!dict) return { changed: false, reason: 'collect dict missing' }
      return { changed: setMembership(dict, word, full ?? findFullWord(state, word), !!value) }
    }

    case 'word.wrong.add': {
      const { word, full } = payload as { word: string; full?: any }
      const dict = findSystemDict(state, 'word', [SYSTEM_DICT_IDS.wrong, 'wrong'])
      if (!dict) return { changed: false, reason: 'wrong dict missing' }
      return { changed: setMembership(dict, word, full ?? findFullWord(state, word), true) }
    }

    case 'word.wrong.remove': {
      const { word } = payload as { word: string }
      const dict = findSystemDict(state, 'word', [SYSTEM_DICT_IDS.wrong, 'wrong'])
      if (!dict) return { changed: false, reason: 'wrong dict missing' }
      return { changed: setMembership(dict, word, null, false) }
    }

    case 'word.note.set': {
      const { word, note } = payload as { word: string; note: string }
      if (!isPlainObject(state.noteData)) state.noteData = {}
      const noteData = state.noteData
      // 统一 key 规范：一律小写，消除两端 key 漂移
      const key = String(word ?? '').toLowerCase()
      if (!key) return { changed: false }
      const next = typeof note === 'string' ? note.trim() : ''
      const prevRaw = noteData[key]
      const prev = typeof prevRaw === 'string' ? prevRaw.trim() : ''
      let changed = false
      // 清理历史上大小写不一致的残留 key
      for (const k of Object.keys(noteData)) {
        if (k !== key && k.toLowerCase() === key) {
          delete noteData[k]
          changed = true
        }
      }
      if (prev !== next) {
        changed = true
        if (next === '') delete noteData[key]
        else noteData[key] = note
      }
      return { changed }
    }

    case 'word.fsrs.set': {
      const { word, card } = payload as { word: string; card: any }
      const key = String(word ?? '').toLowerCase()
      if (!key || !isPlainObject(card)) return { changed: false }
      if (!isPlainObject(state.fsrsData)) state.fsrsData = {}
      const prev = state.fsrsData[key]
      // 幂等：内容一致则不产生变更（避免离线重放导致 revision 虚增）
      if (prev && JSON.stringify(prev) === JSON.stringify(card)) return { changed: false }
      state.fsrsData[key] = card
      return { changed: true }
    }

    case 'word.fsrs.remove': {
      const key = String((payload as { word: string }).word ?? '').toLowerCase()
      if (!key || !isPlainObject(state.fsrsData)) return { changed: false }
      if (!(key in state.fsrsData)) return { changed: false }
      delete state.fsrsData[key]
      return { changed: true }
    }

    case 'dict.progress.set': {
      const { list, dictKey, lastLearnIndex, complete } = payload as any
      const dict = findDictByKey(state, (list ?? 'word') as WordListName, dictKey)
      if (!dict) return { changed: false, reason: 'dict not found: ' + dictKey }
      let changed = false
      if (typeof lastLearnIndex === 'number' && Number.isFinite(lastLearnIndex)) {
        const current = Number(dict.lastLearnIndex) || 0
        // 进度单调不回退：防止离线重放把进度拉回旧值。
        // 用户在冲突弹窗中明确选择「保留本地」时才允许 force 覆盖。
        if (op.force ? current !== lastLearnIndex : lastLearnIndex > current) {
          dict.lastLearnIndex = lastLearnIndex
          changed = true
        }
      }
      if (typeof complete === 'boolean' && !!dict.complete !== complete) {
        dict.complete = complete
        changed = true
      }
      return { changed }
    }

    case 'dict.config.set':
    case 'dict.meta.set': {
      const { list, dictKey, patch } = payload as any
      const dict = findDictByKey(state, (list ?? 'word') as WordListName, dictKey)
      if (!dict) return { changed: false, reason: 'dict not found: ' + dictKey }
      return { changed: assignPatch(dict, patch) }
    }

    case 'dict.statistics.push': {
      const { list, dictKey, entries } = payload as any
      const dict = findDictByKey(state, (list ?? 'word') as WordListName, dictKey)
      if (!dict) return { changed: false, reason: 'dict not found: ' + dictKey }
      if (!Array.isArray(dict.statistics)) dict.statistics = []
      if (!Array.isArray(entries) || !entries.length) return { changed: false }
      const existing = new Set(dict.statistics.map((s: any) => statisticsEntryKey(s)))
      let changed = false
      for (const entry of entries) {
        if (!isPlainObject(entry)) continue
        const key = statisticsEntryKey(entry)
        if (existing.has(key)) continue
        existing.add(key)
        dict.statistics.push(entry)
        changed = true
      }
      return { changed }
    }

    case 'dict.add': {
      const { list, dict } = payload as any
      const name = (list ?? 'word') as WordListName
      if (!isPlainObject(dict)) return { changed: false, reason: 'invalid dict' }
      if (!state[name]) state[name] = { bookList: [], studyIndex: -1 }
      if (!Array.isArray(state[name].bookList)) state[name].bookList = []
      const ids = dictIdentityList(dict)
      const exists = state[name].bookList.some((d: any) => dictIdentityList(d).some(id => ids.includes(id)))
      if (exists) return { changed: false }
      const next = { ...dict }
      // 官方词书的 words 会被剥离，`length` 必须沿用调用方给出的真实词数，不能由 words 推导
      if (typeof next.length !== 'number') {
        if (Array.isArray(next.words)) next.length = next.words.length
        else if (Array.isArray(next.articles)) next.length = next.articles.length
      }
      state[name].bookList.push(next)
      return { changed: true }
    }

    case 'dict.remove': {
      const { list, dictKey } = payload as any
      const name = (list ?? 'word') as WordListName
      const bookList = state?.[name]?.bookList
      if (!Array.isArray(bookList)) return { changed: false }
      const removedIndex = bookList.findIndex((d: any) => dictIdentityList(d).includes(String(dictKey)))
      if (removedIndex === -1) return { changed: false }
      bookList.splice(removedIndex, 1)
      const pointer = Number(state[name].studyIndex)
      if (Number.isInteger(pointer) && pointer >= 0) {
        if (pointer > removedIndex) state[name].studyIndex = pointer - 1
        else if (pointer === removedIndex) state[name].studyIndex = Math.min(pointer, bookList.length - 1)
      }
      return { changed: true }
    }

    case 'dict.content.replace': {
      const { list, dictKey, words, articles } = payload as any
      const dict = findDictByKey(state, (list ?? 'word') as WordListName, dictKey)
      if (!dict) return { changed: false, reason: 'dict not found: ' + dictKey }
      let changed = false
      if (Array.isArray(words)) {
        dict.words = words
        dict.length = words.length
        changed = true
      }
      if (Array.isArray(articles)) {
        dict.articles = articles
        dict.length = articles.length
        changed = true
      }
      return { changed }
    }

    case 'study.index.set': {
      const { list, dictKey } = payload as any
      const name = (list ?? 'word') as WordListName
      const pointer = findDictByKey(state, name, dictKey)
      const index = pointer ? (state[name].bookList as any[]).indexOf(pointer) : -1
      if (state[name].studyIndex === index) return { changed: false }
      state[name].studyIndex = index
      return { changed: true }
    }

    case 'article.collect.set': {
      const { articleId, value, full } = payload as any
      const dict = findSystemDict(state, 'article', [SYSTEM_DICT_IDS.articleCollect, 'articleCollect'])
      if (!dict) return { changed: false, reason: 'article collect dict missing' }
      if (!Array.isArray(dict.articles)) dict.articles = []
      const idx = dict.articles.findIndex((a: any) => String(a?.id) === String(articleId))
      const has = idx !== -1
      const on = !!value
      if (on === has) return { changed: false }
      if (on) dict.articles.push(full ?? { id: articleId })
      else dict.articles.splice(idx, 1)
      dict.length = dict.articles.length
      return { changed: true }
    }

    case 'setting.patch': {
      let changed = false
      for (const [k, v] of Object.entries(payload)) {
        if (k === 'load' || k === '_ignoreWatch') continue
        if (state[k] !== v) {
          state[k] = v
          changed = true
        }
      }
      return { changed }
    }

    /** 整文档替换由服务端直接落库，reducer 不负责应用；客户端收到后走全量重载 */
    case 'doc.replace':
      return { changed: false, reason: 'handled by server' }

    /**
     * 练习会话缓存是「大块整快照」，不进 reducer 的状态；
     * 这里只作为通知，客户端收到后按 scope 重新拉取会话快照。
     */
    case 'practice.session.set':
      return { changed: false, reason: 'notification only' }

    default:
      return { changed: false, reason: 'unknown kind: ' + String(op.kind) }
  }
}

/** 由 kind + payload 推导冲突域，双端共用 */
export function deriveEntityKeys(kind: OperationKind | string, payload: any = {}): string[] {
  const p = payload ?? {}
  if (kind.startsWith('word.')) return ['word:' + String(p.word ?? '').toLowerCase()]
  if (kind === 'article.collect.set') return ['article-collect:' + String(p.articleId)]
  if (kind === 'setting.patch') return Object.keys(p).map(k => 'setting:' + k)
  if (kind === 'doc.replace') return ['*']
  if (kind === 'study.index.set') return ['study:' + (p.list ?? 'word')]
  if (kind.startsWith('dict.')) {
    const list = p.list ?? 'word'
    if (kind === 'dict.content.replace') return [`dict:${list}:${p.dictKey}:content`]
    return [`dict:${list}:${p.dictKey}`]
  }
  return ['*']
}

export interface CreateOperationInput {
  opId: string
  kind: OperationKind
  payload?: Record<string, any>
  baseRevision?: number
  origin?: OperationOrigin
  clientTs?: string
  force?: boolean
}

/** 构造一个操作，自动推导 conflict 域 */
export function createOperation(input: CreateOperationInput): Operation {
  const payload = input.payload ?? {}
  return {
    opId: input.opId,
    kind: input.kind,
    payload,
    clientTs: input.clientTs ?? new Date().toISOString(),
    baseRevision: Number.isFinite(input.baseRevision as number) ? Number(input.baseRevision) : 0,
    origin: input.origin ?? 'browser',
    entityKeys: deriveEntityKeys(input.kind, payload),
    force: input.force,
  }
}

/** 实体域是否相交（用于服务端冲突判定与客户端合并决策） */
export function entityKeysIntersect(a: string[], b: string[]): boolean {
  if (!a?.length || !b?.length) return false
  if (a.includes('*') || b.includes('*')) return true
  const set = new Set(a)
  return b.some(k => set.has(k))
}

/**
 * 可自动合并的操作（集合增删、统计追加、进度单调推进）。
 * 这些操作在最新基准上重新提交即可得到正确结果，无需用户介入。
 */
export const AUTO_MERGE_KINDS: OperationKind[] = [
  'word.known.set',
  'word.collect.set',
  'word.wrong.add',
  'word.wrong.remove',
  'word.fsrs.set',
  'word.fsrs.remove',
  'dict.statistics.push',
  'article.collect.set',
]

/** 需要用户「弹窗选边」的操作（标量覆盖 / 粗粒度结构变更 / 大块导入） */
export const USER_DECISION_KINDS: OperationKind[] = [
  'setting.patch',
  'word.note.set',
  'dict.progress.set',
  'dict.config.set',
  'dict.meta.set',
  'dict.add',
  'dict.remove',
  'dict.content.replace',
  'study.index.set',
]

export function needsUserDecision(kind: OperationKind | string): boolean {
  return USER_DECISION_KINDS.includes(kind as OperationKind)
}

export function isAutoMergeable(kind: OperationKind | string): boolean {
  return AUTO_MERGE_KINDS.includes(kind as OperationKind)
}
