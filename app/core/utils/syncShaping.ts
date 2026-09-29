/**
 * 同步时的数据整形规则。
 *
 * 官方词书的 `words` 数组只用于本地练习（按需从远端资源加载），
 * 服务端文档里必须剥掉，否则每次同步都要传输并存储整本词库（原 `shakeCommonDict` 的职责）。
 * 这里把它抽成单条词典粒度的函数，供「按词典提交操作」的路径复用。
 */
import type { Dict } from '../types'
import { cloneDeep } from './index.ts'

export function thinDictForSync(dict: Dict): Dict {
  const next = cloneDeep(dict)
  // 自定义词典与系统虚拟词典（收藏/错词/已掌握）必须保留 words，否则列表为空
  if (!next.custom && !next.system) {
    next.words = []
  }
  if (Array.isArray(next.articles) && next.articles.length) {
    // sections 是运行时生成的，持久化时丢弃以节省体积
    next.articles = next.articles.map((article: any) => ({ ...article, sections: [] }))
  }
  return next
}
