export default defineEventHandler(() => {
  return {
    openapi: '3.0.0',
    info: { title: 'TypeWords API', version: '1.0.0', description: 'Agent 对接接口' },
    paths: {
      '/api/health': { get: { summary: '健康检查' } },
      '/api/overview': { get: { summary: '全局学习概览' } },
      '/api/dicts': { get: { summary: '词书列表' } },
      '/api/dicts/{id}/progress': { get: { summary: '词书进度与统计' } },
      '/api/statistics': { get: { summary: '学习统计（含按日聚合）' } },
      '/api/words': { get: { summary: '单词列表（filter=known|wrong|collect|due）' } },
      '/api/words/{word}': { get: { summary: '单词详情与标记' } },
      '/api/words/{word}/known': { post: { summary: '标记/取消已掌握' } },
      '/api/words/{word}/collect': { post: { summary: '收藏/取消收藏' } },
      '/api/words/{word}/note': { post: { summary: '写单词笔记' } },
      '/api/export': { get: { summary: '导出全量数据' } },
      '/api/import': { post: { summary: '导入数据' } },
    },
  }
})