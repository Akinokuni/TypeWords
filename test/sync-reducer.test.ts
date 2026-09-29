/**
 * 双端一致性测试。
 *
 * 使用 Node 内置的 `node:test` + 原生 TypeScript 类型擦除，不引入额外依赖。
 *
 * 覆盖：
 * 1. 幂等性 —— 重复应用同一操作不改变状态（离线重放安全）
 * 2. 可重放性 —— 同一操作序列在任意切分点分批应用，结果一致
 * 3. 行为对齐 —— 「标记已掌握同时移出错词本」等隐式约定由唯一 reducer 保证
 * 4. 冲突域推导 —— 实体键决定乐观并发粒度
 * 5. shared/ 约束 —— 不得 import Vue / Nitro
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  applyOperation,
  createOperation,
  deriveEntityKeys,
  entityKeysIntersect,
  findDictByKey,
  scopeOfOperation,
  setMembership,
  statisticsEntryKey,
} from '../shared/domain/applyOperation.ts'

const here = dirname(fileURLToPath(import.meta.url))

function seedState() {
  return {
    word: {
      studyIndex: 3,
      bookList: [
        { id: 'wordCollect', enName: 'wordCollect', name: '收藏', system: true, words: [], length: 0 },
        { id: 'wordWrong', enName: 'wordWrong', name: '错词', system: true, words: [], length: 0 },
        { id: 'wordKnown', enName: 'wordKnown', name: '已掌握', system: true, words: [], length: 0 },
        {
          id: 'nce1',
          enName: 'nce1',
          name: '新概念 1',
          words: [{ word: 'abandon', trans: [{ pos: 'v.', cn: '放弃' }] }],
          length: 2000,
          lastLearnIndex: 0,
          perDayStudyNumber: 20,
          complete: false,
          statistics: [],
        },
      ],
    },
    article: {
      studyIndex: -1,
      bookList: [{ id: 'articleCollect', enName: 'articleCollect', name: '收藏', system: true, articles: [], length: 0 }],
    },
    fsrsData: {},
    noteData: {},
  }
}

let seq = 0
function mkOp(kind: string, payload: any, extra: any = {}) {
  seq += 1
  return createOperation({ opId: 'op-' + seq, kind: kind as any, payload, baseRevision: 0, origin: 'browser', ...extra })
}

const OPERATIONS: Array<[string, any]> = [
  ['word.known.set', { word: 'Abandon', value: true }],
  ['word.known.set', { word: 'abandon', value: true }],
  ['word.collect.set', { word: 'abandon', value: true }],
  ['word.note.set', { word: 'ABANDON', note: 'v. 放弃' }],
  ['word.wrong.add', { word: 'abandon' }],
  ['word.fsrs.set', { word: 'abandon', card: { due: '2026-01-01T00:00:00.000Z', reps: 1, state: 1 } }],
  ['dict.progress.set', { dictKey: 'nce1', lastLearnIndex: 20 }],
  ['dict.progress.set', { dictKey: 'nce1', lastLearnIndex: 10 }],
  ['dict.statistics.push', { dictKey: 'nce1', entries: [{ id: 's1:100:0', startDate: 100, spend: 5000, total: 20, new: 20, review: 0, wrong: 1 }] }],
  ['dict.statistics.push', { dictKey: 'nce1', entries: [{ id: 's1:100:0', startDate: 100, spend: 5000, total: 20, new: 20, review: 0, wrong: 1 }] }],
  ['setting.patch', { theme: 'dark', wordReviewRatio: 2 }],
]

test('幂等性：重复应用同一操作不改变状态（离线重放安全）', () => {
  for (const [kind, payload] of OPERATIONS) {
    const state = seedState()
    const op = mkOp(kind, payload)
    applyOperation(state, op)
    const after = structuredClone(state)
    const second = applyOperation(state, op)
    assert.deepEqual(state, after, `${kind} 第二次应用改变了状态`)
    assert.equal(second.changed, false, `${kind} 第二次应用应返回 changed=false`)
  }
})

test('可重放性：任意切分点分批应用，结果一致', () => {
  const full = seedState()
  for (const [kind, payload] of OPERATIONS) applyOperation(full, mkOp(kind, payload))

  for (let split = 0; split <= OPERATIONS.length; split++) {
    const state = seedState()
    for (const [kind, payload] of OPERATIONS.slice(0, split)) applyOperation(state, mkOp(kind, payload))
    for (const [kind, payload] of OPERATIONS.slice(split)) applyOperation(state, mkOp(kind, payload))
    assert.deepEqual(state, full, `在切分点 ${split} 处结果不一致`)
  }
})

test('行为对齐：标记已掌握会同步移出错词本', () => {
  const state = seedState()
  applyOperation(state, mkOp('word.wrong.add', { word: 'abandon' }))
  assert.equal(findDictByKey(state, 'word', 'wordWrong').words.length, 1)

  applyOperation(state, mkOp('word.known.set', { word: 'abandon', value: true }))
  assert.equal(findDictByKey(state, 'word', 'wordKnown').words.length, 1)
  assert.equal(findDictByKey(state, 'word', 'wordWrong').words.length, 0, '标记已掌握应移出错词本')

  // 取消已掌握不应把词加回错词本
  applyOperation(state, mkOp('word.known.set', { word: 'abandon', value: false }))
  assert.equal(findDictByKey(state, 'word', 'wordKnown').words.length, 0)
  assert.equal(findDictByKey(state, 'word', 'wordWrong').words.length, 0)
})

test('大小写：单词标记与笔记 key 统一按小写归并', () => {
  const state = seedState()
  applyOperation(state, mkOp('word.known.set', { word: 'Abandon', value: true }))
  const known = findDictByKey(state, 'word', 'wordKnown')
  assert.equal(known.words.length, 1)

  // 不同大小写的同一单词再次标记为已掌握 => 幂等
  const again = applyOperation(state, mkOp('word.known.set', { word: 'ABANDON', value: true }))
  assert.equal(again.changed, false)
  assert.equal(known.words.length, 1)

  applyOperation(state, mkOp('word.note.set', { word: 'ABANDON', note: '放弃' }))
  assert.equal(state.noteData.abandon, '放弃')
  assert.equal(Object.keys(state.noteData).length, 1, '不应产生大写 key 的残留')
})

test('进度单调：离线重放不会把进度拉回旧值，force 才允许显式回退', () => {
  const state = seedState()
  applyOperation(state, mkOp('dict.progress.set', { dictKey: 'nce1', lastLearnIndex: 20 }))
  const rewind = applyOperation(state, mkOp('dict.progress.set', { dictKey: 'nce1', lastLearnIndex: 10 }))
  assert.equal(rewind.changed, false)
  assert.equal(findDictByKey(state, 'word', 'nce1').lastLearnIndex, 20)

  const forced = applyOperation(state, mkOp('dict.progress.set', { dictKey: 'nce1', lastLearnIndex: 10 }, { force: true }))
  assert.equal(forced.changed, true)
  assert.equal(findDictByKey(state, 'word', 'nce1').lastLearnIndex, 10)
})

test('统计追加：按稳定 id 去重（学习记录只增不减）', () => {
  const state = seedState()
  const entry = { id: 'sess-1:1000:0', startDate: 1000, spend: 60000, total: 20, new: 20, review: 0, wrong: 2 }
  applyOperation(state, mkOp('dict.statistics.push', { dictKey: 'nce1', entries: [entry] }))
  applyOperation(state, mkOp('dict.statistics.push', { dictKey: 'nce1', entries: [entry] }))
  assert.equal(findDictByKey(state, 'word', 'nce1').statistics.length, 1)

  // 历史数据没有 id 时按内容指纹去重
  const legacy = { startDate: 2000, spend: 1000, total: 5, new: 5, review: 0, wrong: 0 }
  applyOperation(state, mkOp('dict.statistics.push', { dictKey: 'nce1', entries: [legacy] }))
  applyOperation(state, mkOp('dict.statistics.push', { dictKey: 'nce1', entries: [{ ...legacy }] }))
  assert.equal(findDictByKey(state, 'word', 'nce1').statistics.length, 2)
  assert.equal(statisticsEntryKey(legacy), statisticsEntryKey({ ...legacy }))
})

test('集合成员增减：状态一致时不产生变更', () => {
  const dict = { words: [{ word: 'a' }], length: 1 }
  assert.equal(setMembership(dict, 'a', null, true), false)
  assert.equal(setMembership(dict, 'a', null, false), true)
  assert.equal(setMembership(dict, 'a', null, false), false)
  assert.equal(dict.words.length, 0)
})

test('冲突域推导：实体键决定乐观并发粒度', () => {
  assert.deepEqual(deriveEntityKeys('word.known.set', { word: 'Abandon' }), ['word:abandon'])
  assert.deepEqual(deriveEntityKeys('dict.progress.set', { list: 'word', dictKey: 'nce1' }), ['dict:word:nce1'])
  assert.deepEqual(deriveEntityKeys('dict.content.replace', { list: 'word', dictKey: 'nce1' }), ['dict:word:nce1:content'])
  assert.deepEqual(deriveEntityKeys('setting.patch', { theme: 'dark', voice: 'us' }).sort(), ['setting:theme', 'setting:voice'])
  assert.deepEqual(deriveEntityKeys('doc.replace', {}), ['*'])

  // 不相交 => 不冲突（Agent 批量标记单词 与 用户练另一本词书 互不阻塞）
  assert.equal(entityKeysIntersect(['word:abandon'], ['dict:word:nce1']), false)
  assert.equal(entityKeysIntersect(['dict:word:nce1'], ['dict:word:nce1']), true)
  assert.equal(entityKeysIntersect(['*'], ['word:abandon']), true)
})

/** 集合型域（收藏/错词/已掌握）的收敛保证是「内容一致」，数组顺序可能因应用先后而不同 */
function normalizeCollections(state: any) {
  const next = structuredClone(state)
  for (const dict of next.word.bookList) {
    if (Array.isArray(dict.words)) dict.words.sort((a: any, b: any) => String(a.word).localeCompare(String(b.word)))
  }
  next.article.bookList.forEach((dict: any) => {
    if (Array.isArray(dict.articles)) dict.articles.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))
  })
  return next
}

test('「同一操作序列在两端各自应用」结果一致（双端等价）', () => {
  const client = seedState()
  const server = seedState()
  // 服务端按提交顺序应用，客户端先乐观应用自己的、再应用拉到别人的
  const mine = OPERATIONS.map(([kind, payload]) => mkOp(kind, payload))
  const others = [
    mkOp('word.collect.set', { word: 'ability', value: true }),
    mkOp('dict.progress.set', { dictKey: 'nce1', lastLearnIndex: 30 }),
  ]

  for (const op of mine) applyOperation(client, op)
  for (const op of others) applyOperation(server, op)
  for (const op of others) applyOperation(client, op)
  for (const op of mine) applyOperation(server, op)

  assert.deepEqual(
    normalizeCollections(client),
    normalizeCollections(server),
    '两端最终状态必须一致（集合内容一致；数组顺序允许因应用先后不同）'
  )
})

test('scope 推导：setting.patch 属于 setting 文档，其余属于 dict（服务端据此拒绝错配请求）', () => {
  assert.equal(scopeOfOperation('setting.patch'), 'setting')
  assert.equal(scopeOfOperation('word.known.set'), 'dict')
  assert.equal(scopeOfOperation('dict.progress.set'), 'dict')
  assert.equal(scopeOfOperation('doc.replace'), 'dict')
})

test('shared/ 不得依赖 Vue / Nitro（SSR 安全约束）', () => {
  for (const file of ['applyOperation.ts', join('..', 'types', 'ops.ts')]) {
    const source = readFileSync(join(here, '..', 'shared', 'domain', file), 'utf8')
    assert.doesNotMatch(source, /from ['"](vue|pinia|h3|#imports|nuxt)['"]/, `${file} 引入了不允许的依赖`)
  }
})
