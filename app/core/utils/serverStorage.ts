import { get } from 'idb-keyval'

export type StoreKey = 'dict' | 'setting' | 'practice_word' | 'practice_article' | 'practice_sentence'

export async function fetchStoreValue(key: StoreKey): Promise<string | null> {
  try {
    const res = await $fetch<{ value: string | null }>('/api/data/' + key)
    return res?.value ?? null
  } catch (e) {
    console.error('[serverStorage] fetch ' + key + ' failed', e)
    return null
  }
}

export async function saveStoreValue(
  key: StoreKey,
  value: string,
  options?: { keepalive?: boolean }
): Promise<boolean> {
  try {
    await $fetch('/api/data/' + key, { method: 'PUT', body: { value }, keepalive: options?.keepalive })
    return true
  } catch (e) {
    console.error('[serverStorage] save ' + key + ' failed', e)
    return false
  }
}

// 优先读服务端；服务端为空时回退到 IndexedDB 并一次性迁移到服务端
export async function loadOrMigrate(key: StoreKey, idbKey: string): Promise<string | null> {
  const serverVal = await fetchStoreValue(key)
  if (serverVal) return serverVal
  try {
    const local = (await get(idbKey)) as string | undefined
    if (local) {
      await saveStoreValue(key, local)
      return local
    }
  } catch (e) {
    console.error('[serverStorage] migrate ' + key + ' failed', e)
  }
  return null
}
