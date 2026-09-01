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
    if (local) return local
    return (await backup.restoreIfAbsent('practice_sentence', PRACTICE_SENTENCE_CACHE.key)) as PracticeSentenceCache | null
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
