/**
 * 练习会话缓存的服务端备份 key 白名单。
 * 与 app/core/utils/serverStorage.ts 的 StoreKey 中练习相关部分保持一致。
 */
export const PRACTICE_STORE_KEYS = ['practice_word', 'practice_article', 'practice_sentence'] as const

export type PracticeStoreKey = (typeof PRACTICE_STORE_KEYS)[number]

export function isPracticeStoreKey(key: string): key is PracticeStoreKey {
  return (PRACTICE_STORE_KEYS as readonly string[]).includes(key)
}
