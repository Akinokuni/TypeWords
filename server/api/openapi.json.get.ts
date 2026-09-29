export default defineEventHandler(() => {
  return {
    openapi: '3.0.0',
    info: {
      title: 'TypeWords API',
      version: '1.1.0',
      description:
        'Agent 对接接口。写入统一走操作（Operation）+ 单调修订号（revision）：' +
        '每个写接口的返回体都带 revision，可用于乐观并发与增量同步。',
    },
    paths: {
      '/api/health': { get: { summary: '健康检查' } },
      '/api/overview': { get: { summary: '全局学习概览' } },
      '/api/dicts': { get: { summary: '词书列表' } },
      '/api/dicts/{id}/progress': { get: { summary: '词书进度与统计' } },
      '/api/statistics': { get: { summary: '学习统计（含按日聚合）' } },
      '/api/words': { get: { summary: '单词列表（filter=known|wrong|collect|due）' } },
      '/api/words/{word}': { get: { summary: '单词详情与标记' } },
      '/api/words/{word}/known': {
        post: {
          summary: '标记/取消已掌握（内部提交 word.known.set 操作）',
          description: '不传 value 时按当前状态取反；返回 { word, known, changed, revision }。可传 opId 实现重试幂等。',
        },
      },
      '/api/words/{word}/collect': {
        post: {
          summary: '收藏/取消收藏（内部提交 word.collect.set 操作）',
          description: '不传 value 时按当前状态取反；返回 { word, collect, changed, revision }。',
        },
      },
      '/api/words/{word}/note': {
        post: {
          summary: '写/删单词笔记（内部提交 word.note.set 操作）',
          description: 'note 为空字符串即删除；笔记 key 统一小写。返回 { word, note, changed, revision }。',
        },
      },
      '/api/ops': {
        get: {
          summary: '增量拉取操作日志',
          parameters: [
            { name: 'since', in: 'query', required: false, schema: { type: 'integer' }, description: '已应用的最后修订号，默认 0' },
          ],
          description: '返回 { revision, mode: "ops" | "snapshot-required", ops: [...] }；落后超过 500 条时返回 snapshot-required。',
        },
        post: {
          summary: '提交操作（浏览器端与 Agent 共用）',
          description:
            '请求体 { scope: "dict" | "setting", ops: Operation[] }；' +
            '按「操作影响的实体键」做乐观并发校验：实体不相交则直接应用，相交且 baseRevision 落后则返回 conflicts。' +
            'opId 全局唯一，重复提交幂等。',
        },
      },
      '/api/ops/stream': {
        get: { summary: 'SSE 反向通道：服务端有新操作时推送通知（含 25s 心跳）' },
      },
      '/api/data/{key}': {
        get: { summary: '读取原始文档/练习缓存（返回 value 与 revision）' },
        put: { summary: '整文档覆盖写入（仅限初始化与导入场景，会递增 revision 并广播 doc.replace）' },
      },
      '/api/export': { get: { summary: '导出全量数据' } },
      '/api/import': { post: { summary: '导入数据' } },
    },
  }
})
