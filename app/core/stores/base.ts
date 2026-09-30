import { defineStore } from 'pinia'
import { type Dict, getDefaultDict, type SaveData, type Word } from '../types'
import {
  _getStudyProgress,
  checkAndUpgradeSaveDict,
  isSameDictResource,
  parseJsonStr,
} from '../utils'
import { thinDictForSync } from '../utils/syncShaping'
import { shallowReactive } from 'vue'
import { loadOrMigrate, saveStoreValue } from '../utils/serverStorage'
import { readScopeCursor, readShadow, writeScopeCursor, writeShadow } from '../utils/offlineOutbox'
import { dispatchOps } from '../utils/opsBridge'
import { DictId, IS_DEV, SAVE_DICT_KEY } from '../config/env'
import type { Card } from 'ts-fsrs'
import { useSettingStore } from './setting.ts'
import { useRuntimeStore } from './runtime.ts'

export interface BaseState {
  simpleWords: string[]
  load: boolean
  word: {
    studyIndex: number
    bookList: Dict[]
  }
  article: {
    bookList: Dict[]
    studyIndex: number
  }
  dictListVersion: number
  fsrsData: Record<string, Card>
  noteData: Record<string, string> // 集中存储单词笔记，key 为单词字符串
  _ignoreWatch: boolean //忽略监听，避免重复保存和上传
}

export const getDefaultBaseState = (): BaseState => ({
  simpleWords: [
    'a',
    'an',
    'i',
    'my',
    'me',
    'you',
    'your',
    'he',
    'his',
    'she',
    'her',
    'it',
    'what',
    'who',
    'where',
    'how',
    'when',
    'which',
    'be',
    'am',
    'is',
    'was',
    'are',
    'were',
    'do',
    'did',
    'can',
    'could',
    'will',
    'would',
    'the',
    'that',
    'this',
    'and',
    'not',
    'no',
    'yes',
    'to',
    'of',
    'for',
    'at',
    'in',
  ],
  load: false,
  word: {
    bookList: [
      getDefaultDict({ id: DictId.wordCollect, enName: DictId.wordCollect, name: '收藏', system: true }),
      getDefaultDict({ id: DictId.wordWrong, enName: DictId.wordWrong, name: '错词', system: true }),
      getDefaultDict({
        id: DictId.wordKnown,
        enName: DictId.wordKnown,
        name: '已掌握',
        description: '已掌握后的单词不会出现在练习中',
        system: true,
      }),
    ],
    studyIndex: -1,
  },
  article: {
    bookList: [
      getDefaultDict({ id: DictId.articleCollect, enName: DictId.articleCollect, name: '收藏', system: true }),
    ],
    studyIndex: -1,
  },
  dictListVersion: 1,
  fsrsData: {},
  noteData: {},
  _ignoreWatch: false,
})

export const useBaseStore = defineStore('base', {
  state: (): BaseState => {
    return getDefaultBaseState()
  },
  getters: {
    collectWord(): Dict {
      let res = this.word.bookList.find(v => [v.enName, v.id].includes(DictId.wordCollect))
      return res ?? getDefaultDict()
    },
    collectArticle(): Dict {
      let res = this.article.bookList.find(v => [v.enName, v.id].includes(DictId.articleCollect))
      return res ?? getDefaultDict()
    },
    wrong(): Dict {
      let res = this.word.bookList.find(v => [v.enName, v.id].includes(DictId.wordWrong))
      return res ?? getDefaultDict()
    },
    known(): Dict {
      let res = this.word.bookList.find(v => [v.enName, v.id].includes(DictId.wordKnown))
      return res ?? getDefaultDict()
    },
    knownWords(): string[] {
      return this.known.words.map((v: Word) => v.word.toLowerCase())
    },
    allIgnoreWords(): string[] {
      return this.known.words
        .map((v: Word) => v.word.toLowerCase())
        .concat(this.simpleWords.map((v: string) => v.toLowerCase()))
    },
    knownWordsSet(): Set<string> {
      return new Set<string>(this.known.words.map((v: Word) => v.word))
    },
    allIgnoreWordsSet(): Set<string> {
      return new Set<string>(this.known.words.map((v: Word) => v.word).concat(this.simpleWords.map((v: string) => v)))
    },
    sdict(): Dict {
      if (this.word.studyIndex >= 0) {
        return this.word.bookList[this.word.studyIndex] ?? getDefaultDict()
      }
      return getDefaultDict()
    },
    groupLength(): number {
      return Math.ceil(this.sdict.length / this.sdict.perDayStudyNumber)
    },
    currentGroup(): number {
      //当能除尽时，应该加1
      let s = this.sdict.lastLearnIndex % this.sdict.perDayStudyNumber
      let d = this.sdict.lastLearnIndex / this.sdict.perDayStudyNumber
      return Math.floor(s === 0 ? d + 1 : d)
    },
    currentStudyProgress(): number {
      if (!this.sdict.length) return 0
      return _getStudyProgress(this.sdict.lastLearnIndex, this.sdict.length)
    },
    sbook(): Dict {
      return this.article.bookList[this.article.studyIndex] ?? getDefaultDict()
    },
    currentBookProgress(): number {
      if (!this.sbook.length) return 0
      if (this.sbook.complete) return 100
      return _getStudyProgress(this.sbook.lastLearnIndex, this.sbook.length)
    },
  },
  actions: {
    getIgnoreWordsSet(): Set<string> {
      let settingStore = useSettingStore()
      return [this.allIgnoreWordsSet, this.knownWordsSet][settingStore.ignoreSimpleWord ? 0 : 1]
    },
    setState(obj: BaseState) {
      obj.word.bookList.map(book => {
        book.words = shallowReactive(book.words)
        book.articles = shallowReactive(book.articles)
        book.statistics = shallowReactive(book.statistics)
      })
      obj.article.bookList.map(book => {
        book.words = shallowReactive(book.words)
        book.articles = shallowReactive(book.articles)
        book.statistics = shallowReactive(book.statistics)
      })
      //必须先 reset, 只 $patch 无法将 state 恢复到默认值
      this.$reset()
      console.time('$patch')
      if (IS_DEV) {
        this.$state = obj
      } else {
        this.$patch(obj)
      }
      console.timeEnd('$patch')
    },
    /**
     * 初始化词典数据。
     *
     * 关键不变量：**只有「请求成功且服务端确认无数据」时**才写入默认状态。
     * 请求失败时必须走本地影子副本降级或保持未初始化，绝不能把默认空状态写回服务端
     * （否则容器重启 / 反代 502 / 断网刷新会清空服务端全部学习数据）。
     */
    async init(): Promise<SaveData | null> {
      const runtimeStore = useRuntimeStore()
      // 带上本地副本的文档时间戳：服务端判定未变化时不下发正文，省去整份词库的传输
      const cursor = await readScopeCursor('dict')
      const outcome = await loadOrMigrate('dict', SAVE_DICT_KEY.key, cursor.updatedAt)

      if (!outcome.ok) {
        const shadow = await readShadow('dict')
        if (shadow) {
          try {
            const result = await parseJsonStr(shadow, checkAndUpgradeSaveDict)
            this.setState(result.val)
            runtimeStore.syncState = 'offline'
            console.warn('[base.init] 后端不可达，已使用本地影子副本启动（离线模式，操作将排队等待同步）')
            return result
          } catch (error) {
            console.error('[base.init] 影子副本解析失败', error)
          }
        }
        runtimeStore.syncState = 'unavailable'
        console.error('[base.init] 后端不可达且无本地副本：保持未初始化，拒绝写入默认状态以免覆盖服务端数据')
        return null
      }

      if (outcome.unchanged) {
        const shadow = await readShadow('dict')
        if (shadow) {
          try {
            const result = await parseJsonStr(shadow, checkAndUpgradeSaveDict)
            this.setState(result.val)
            runtimeStore.syncState = 'online'
            return result
          } catch (error) {
            console.error('[base.init] 服务端判定未变化，但本地影子副本解析失败', error)
          }
        }
        // 影子副本缺失或损坏：退回完整拉取，避免把「未变化」误当成「无数据」而写入默认状态
        const full = await loadOrMigrate('dict', SAVE_DICT_KEY.key)
        if (full.ok && full.value) {
          const result = await parseJsonStr(full.value, checkAndUpgradeSaveDict)
          this.setState(result.val)
          await writeShadow('dict', full.value)
          await writeScopeCursor('dict', {
            revision: full.revision,
            updatedAt: full.updatedAt,
            lastSyncedAt: Date.now(),
          })
          runtimeStore.syncState = 'online'
          return result
        }
        runtimeStore.syncState = 'offline'
        console.warn('[base.init] 服务端判定未变化，但本地无可用副本且补充拉取未成功')
        return null
      }

      if (outcome.value) {
        const result = await parseJsonStr(outcome.value, checkAndUpgradeSaveDict)
        this.setState(result.val)
        await writeShadow('dict', outcome.value)
        await writeScopeCursor('dict', {
          revision: outcome.revision,
          updatedAt: outcome.updatedAt,
          lastSyncedAt: Date.now(),
        })
        runtimeStore.syncState = 'online'
        return result
      }

      // 服务端明确为空（且 IndexedDB 里也没有可迁移的旧数据）：真正的首次启动，写入默认状态
      const seed = JSON.stringify({
        val: getDefaultBaseState(),
        version: SAVE_DICT_KEY.version,
        updated_at: new Date().toISOString(),
      })
      const saved = await saveStoreValue('dict', seed, { label: 'seed-default-dict' })
      if (!saved.ok) {
        runtimeStore.syncState = 'offline'
        return null
      }
      await writeShadow('dict', seed)
      if (saved.revision) {
        await writeScopeCursor('dict', { revision: saved.revision, lastSyncedAt: Date.now() })
      }
      runtimeStore.syncState = 'online'
      return null
    },
    //改变词典
    async changeDict(val: Dict) {
      //把其他的词典的单词数据都删掉，全保存在内存里太卡了
      this.word.bookList.slice(3).map(v => {
        if (!v.custom) {
          v.words = shallowReactive([])
        }
      })
      if (val.words?.length) {
        val.length = val.words.length
      }
      let rIndex = this.word.bookList.findIndex((v: Dict) => isSameDictResource(v, val))
      if (val.perDayStudyNumber > val.length) {
        val.perDayStudyNumber = val.length
      }
      if (val.lastLearnIndex > val.length) {
        val.lastLearnIndex = val.length
        val.complete = true
      }
      const dictKey = val.id ?? val.enName
      const ops: Array<{ kind: any; payload: any }> = []
      if (rIndex > -1) {
        this.word.studyIndex = rIndex
        const target = this.word.bookList[this.word.studyIndex]
        const prevConfig = target.perDayStudyNumber
        const prevProgress = target.lastLearnIndex
        const prevComplete = target.complete
        target.words = shallowReactive(val.words)
        target.id = val.id
        target.enName = val.enName
        target.length = val.length
        target.perDayStudyNumber = val.perDayStudyNumber
        target.lastLearnIndex = val.lastLearnIndex
        target.userDictId = val.userDictId
        target.complete = val.complete
        if (prevConfig !== val.perDayStudyNumber) {
          ops.push({ kind: 'dict.config.set', payload: { list: 'word', dictKey, patch: { perDayStudyNumber: val.perDayStudyNumber } } })
        }
        if (prevProgress !== val.lastLearnIndex || prevComplete !== val.complete) {
          ops.push({
            kind: 'dict.progress.set',
            payload: { list: 'word', dictKey, lastLearnIndex: val.lastLearnIndex, complete: val.complete },
          })
        }
      } else {
        this.word.bookList.push(getDefaultDict(val))
        this.word.studyIndex = this.word.bookList.length - 1
        ops.push({ kind: 'dict.add', payload: { list: 'word', dict: thinDictForSync(val) } })
      }
      // 学习指针以「词典 key」下发，双端各自解析成下标，避免下标在并发结构变更后漂移
      if (dictKey !== undefined && dictKey !== null && dictKey !== '') {
        ops.push({ kind: 'study.index.set', payload: { list: 'word', dictKey } })
      }
      if (ops.length) await dispatchOps(ops)
    },
    //改变书籍
    async changeBook(val: Dict) {
      //把其他的书籍里面的文章数据都删掉，全保存在内存里太卡了
      this.article.bookList.slice(1).map(v => {
        if (!v.custom) {
          v.articles = shallowReactive([])
        }
      })
      if (val.articles?.length) {
        val.length = val.articles.length
      }
      if (val.lastLearnIndex > val.length) {
        val.lastLearnIndex = val.length
        val.complete = true
      }
      let rIndex = this.article.bookList.findIndex((v: Dict) => isSameDictResource(v, val))
      const dictKey = val.id ?? val.enName
      const ops: Array<{ kind: any; payload: any }> = []
      if (rIndex > -1) {
        this.article.studyIndex = rIndex
        //不要整个等于，不然统计没了
        const target = this.article.bookList[this.article.studyIndex]
        const prevProgress = target.lastLearnIndex
        const prevComplete = target.complete
        const prevMeta = [target.name, target.description, target.cover].join('|')
        target.articles = shallowReactive(val.articles)
        target.id = val.id
        target.enName = val.enName
        target.length = val.length
        target.cover = val.cover
        target.name = val.name
        target.description = val.description
        if (prevProgress !== val.lastLearnIndex || prevComplete !== val.complete) {
          ops.push({
            kind: 'dict.progress.set',
            payload: { list: 'article', dictKey, lastLearnIndex: val.lastLearnIndex, complete: val.complete },
          })
        }
        if ([val.name, val.description, val.cover].join('|') !== prevMeta) {
          ops.push({
            kind: 'dict.meta.set',
            payload: { list: 'article', dictKey, patch: { name: val.name, description: val.description, cover: val.cover } },
          })
        }
      } else {
        this.article.bookList.push(getDefaultDict(val))
        this.article.studyIndex = this.article.bookList.length - 1
        ops.push({ kind: 'dict.add', payload: { list: 'article', dict: thinDictForSync(val) } })
      }
      if (dictKey !== undefined && dictKey !== null && dictKey !== '') {
        ops.push({ kind: 'study.index.set', payload: { list: 'article', dictKey } })
      }
      if (ops.length) await dispatchOps(ops)
    },
  },
})
