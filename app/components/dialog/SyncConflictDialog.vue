<script setup lang="ts">
/**
 * 同步冲突弹窗（「弹窗选边」）。
 *
 * 触发时机：提交本地操作时，服务端发现**同一实体**已被其它写入者（另一台浏览器或 Agent）
 * 改过，且该操作无法自动合并（进度 / 设置 / 笔记 / 词书结构等）。
 *
 * 用户选择：
 * - 「保留本机」：以当前 revision 为基准、带 force 重新提交这几条操作（进度类允许显式回退）
 * - 「采用服务端」：丢弃这几条本地操作，并从服务端全量重载该范围
 *
 * 可自动合并的操作（集合增删、统计追加）不会走到这里，由 `useOpsSync` 直接重试。
 */
import { computed, defineAsyncComponent } from 'vue'
import { BaseButton } from '@/base'
import { useSyncConflictCenter } from '@/core/composables/useOpsSync'
import { useI18n } from 'vue-i18n'

const Dialog = defineAsyncComponent(() => import('@/base/dialog/Dialog.vue'))
const center = useSyncConflictCenter()
const { t } = useI18n()

const isOpen = computed({
  get: () => center.state.conflictOpen,
  // 用户必须通过按钮选边；忽略组件内部发起的关闭（Esc / 背景点击）以免状态与界面不一致
  set: () => {},
})
const items = computed(() => center.state.conflictItems)

const KIND_LABELS: Record<string, string> = {
  'word.known.set': '已掌握标记',
  'word.collect.set': '收藏',
  'word.wrong.add': '错词',
  'word.wrong.remove': '错词',
  'word.note.set': '单词笔记',
  'word.fsrs.set': '记忆曲线卡片',
  'dict.progress.set': '学习进度',
  'dict.config.set': '词书设置',
  'dict.meta.set': '词书信息',
  'dict.statistics.push': '学习记录',
  'dict.add': '新增词书',
  'dict.remove': '删除词书',
  'dict.content.replace': '词书内容',
  'study.index.set': '当前学习词书',
  'article.collect.set': '文章收藏',
  'setting.patch': '设置项',
  'doc.replace': '整体数据',
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

function summarize(value: unknown, max = 180): string {
  try {
    const text = JSON.stringify(value)
    if (!text) return String(value)
    return text.length > max ? text.slice(0, max) + '…' : text
  } catch {
    return String(value)
  }
}

function serverSummary(item: (typeof items.value)[number]): string {
  const ops = item.conflict.conflictingOps ?? []
  if (!ops.length) return t('sync_conflict_server_updated')
  return summarize(ops.map(op => ({ [op.kind]: op.payload })))
}

function decide(choice: 'local' | 'server') {
  void center.decide(choice)
}
</script>

<template>
  <Dialog
    v-model="isOpen"
    :title="t('sync_conflict_title')"
    padding
    :show-close="false"
    :close-on-click-bg="false"
    :footer="false"
  >
    <div class="w-150">
      <p class="mb-3">{{ t('sync_conflict_desc') }}</p>

      <div class="conflict-list">
        <div v-for="(item, index) in items" :key="index" class="conflict-item">
          <div class="font-bold mb-1">
            {{ kindLabel(String(item.op.kind)) }}
            <span class="text-sm opacity-60">{{ item.op.entityKeys.join(', ') }}</span>
          </div>
          <div class="text-sm">
            <span class="tag-self">{{ t('sync_conflict_tag_local') }}</span> {{ summarize(item.op.payload) }}
          </div>
          <div class="text-sm">
            <span class="tag-server">{{ t('sync_conflict_tag_server') }}</span> {{ serverSummary(item) }}
          </div>
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-4">
        <BaseButton @click="decide('server')">{{ t('sync_conflict_keep_server') }}</BaseButton>
        <BaseButton type="primary" @click="decide('local')">{{ t('sync_conflict_keep_local') }}</BaseButton>
      </div>
    </div>
  </Dialog>
</template>

<style scoped lang="scss">
.conflict-list {
  max-height: 50vh;
  overflow-y: auto;
}

.conflict-item {
  @apply rounded-lg p-3 mb-2;
  background: var(--bg-card-secend);
  word-break: break-all;
}

.tag-self,
.tag-server {
  @apply rounded-md px-1 mr-1;
  font-size: 0.75rem;
}

.tag-self {
  background: color-mix(in srgb, var(--color-link) 18%, transparent);
}

.tag-server {
  background: color-mix(in srgb, orange 18%, transparent);
}
</style>
