# 03 · 后端 API 与 Agent 对接

## 改动目标

新增后端 REST API，暴露核心数据，让外部 **Agent** 能：① 读取具体学习进度与统计；② 对数据执行操作（增删改、标记掌握、调整进度、导出等）。接口设计以「Agent 易读、可自动发现」为优先。

## 现状

- 后端 API 仅有查询单词：`app/core/apis/words.ts` → `public.word/query`（`queryWord`）。
- HTTP 层：`app/core/utils/http.ts`（axios，baseURL = `ENV.API`，默认 `http://localhost/`）。
- `nuxt.config.ts` 中 `nitro.devProxy` 将 `/baidu` 代理到百度翻译（示例了 dev 代理写法）。

## 方案（建议）

### 1. 接口风格（已决策：Agent 易读优先）

采用**标准 REST**，不做业务包裹：

- **成功**：直接返回资源 JSON，HTTP 状态码区分语义：
  - `200` 查询成功 / 更新成功
  - `201` 创建成功（返回创建的实体）
  - `204` 删除成功（无响应体）
- **失败**：非 2xx 状态码 + 统一错误体：

  ```json
  { "error": { "code": "NOT_FOUND", "message": "word 'abandon' not found" } }
  ```

- 常用错误码：`NOT_FOUND` / `VALIDATION_FAILED` / `CONFLICT` / `INTERNAL`。
- **可发现性**：提供 `GET /api/openapi.json`（OpenAPI 3 描述）与 `GET /api/health`，Agent 可据此自动发现并注册工具。

> 与前端内部 HTTP 层（`app/core/utils/http.ts` 的 `{code, success, data, msg}`）解耦：前端内部继续沿用旧封装，`server/api` 对外接口采用上述标准风格。

### 2. 接口清单（草案）

**元信息**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/openapi.json` | OpenAPI 描述（Agent 自动发现） |

**进度 / 统计（读）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/overview` | 全局概览：已学单词数、词书进度、FSRS 卡片数等 |
| GET | `/api/dicts` | 词书/书籍列表 |
| GET | `/api/dicts/:id/progress` | 某词书学习进度（lastLearnIndex、complete 等） |
| GET | `/api/statistics` | 学习统计（spend/total/new/review/wrong，支持 `?range=day|week|all`） |
| GET | `/api/words/:word` | 单词详情（含 FSRS 状态、掌握/收藏/错词标记） |
| GET | `/api/words?filter=wrong|known|collect|due` | 错词/已掌握/收藏/到期词列表 |

**数据操作（写）**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/dicts` | 新建/导入词书（201） |
| PUT | `/api/dicts/:id` | 更新词书（含 perDayStudyNumber、lastLearnIndex） |
| DELETE | `/api/dicts/:id` | 删除词书（204） |
| POST | `/api/words` | 添加单词到指定词书 |
| POST | `/api/words/:word/known` | 标记为已掌握 |
| POST | `/api/words/:word/collect` | 收藏/取消收藏 |
| POST | `/api/words/:word/note` | 写单词笔记（noteData） |
| POST | `/api/practice/record` | 记录一次练习结果（更新 FSRS、统计） |
| GET | `/api/export` | 导出全量数据（备份） |
| POST | `/api/import` | 导入数据 |

> 以上为草案，最终以 02 存储层落定后的实体为准。

### 3. Agent 对接约定

- **无鉴权**（默认），可选 `API_TOKEN` 请求头（见 04）。
- **可发现**：Agent 先读 `/api/openapi.json` 或 `/api/health`，再调用具体接口。
- **幂等**：写操作重复调用不产生副作用（唯一键 + upsert 语义）。
- **确定性**：返回字段命名稳定、类型固定（与 `app/core/types` 对齐），便于 Agent 生成工具 schema。
- **分页**：列表接口支持 `?limit&offset`，返回 `{ items, total }`。

## 涉及文件

- 新增 `server/api/**/*.ts`（接口实现 + OpenAPI/health）
- 修改 `app/core/apis/words.ts`（作为前端调用新 API 的示例）
- 修改 `app/core/utils/http.ts`（baseURL、拦截器适配）
- 修改 `nuxt.config.ts`（必要时 devProxy / origin / server 配置）

## 状态

- 待开始
- 已决策：接口采用标准 REST + JSON（Agent 易读）+ OpenAPI；提供可选 `API_TOKEN`
