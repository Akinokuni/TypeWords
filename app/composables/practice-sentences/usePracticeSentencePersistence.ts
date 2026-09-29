import {
  getPracticeSentenceCacheLocal,
  PRACTICE_SENTENCE_CACHE,
  setPracticeSentenceCacheLocal,
  type PracticeSentenceCache,
} from './practice-sentence-cache.ts'
import { usePracticeServerBackup } from '@/core/composables/usePracticeServerBackup'

export function usePracticeSentencePersistence() {
  const backup = usePracticeServerBackup()

  async function load(): Promise<PracticeSentenceCache | null> {
    const local = await getPracticeSentenceCacheLocal()
    // 本地缺失或比服务端旧时恢复服务端备份（LWW）
    const restored = await backup.restoreIfStale('practice_sentence', PRACTICE_SENTENCE_CACHE.key)
    if (restored != null) return (await getPracticeSentenceCacheLocal()) as PracticeSentenceCache | null
    return local
  }

  async function fetch(): Promise<PracticeSentenceCache | null> {
    return load()
  }

  async function save(data: PracticeSentenceCache | null) {
    await setPracticeSentenceCacheLocal(data)
  }

  async function clear() {
    await setPracticeSentenceCacheLocal(null)
  }

  return { load, fetch, save, clear }
}
