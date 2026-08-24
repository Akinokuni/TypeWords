---
name: typewords-api
description: 读写 TypeWords（英语单词/文章打字练习应用）的学习进度与数据。触发场景：查询学习进度、统计、词书、单词状态、到期复习词，或标记已掌握/收藏、写笔记、导入导出数据。服务默认地址 http://127.0.0.1:5567（Docker 或 pnpm dev 启动）。
---

# TypeWords API

TypeWords 的本地 REST API，供 Agent 读取进度、操作数据。数据存于服务端 SQLite（单文件）。

## 基本信息

- Base URL：`http://127.0.0.1:5567`（可在部署时配置端口/地址）
- 认证：默认无认证；若服务端设置了 `API_TOKEN`，Agent/管理接口需带 `Authorization: Bearer <token>`（`/api/health`、`/api/openapi.json`、`/api/data/*` 除外）
- 自检：先 `GET /api/health` 确认服务可用；`GET /api/openapi.json` 可自动发现接口

## 接口速查

### 读（进度 / 统计 / 单词）
| 接口 | 用途 |
|------|------|
| GET /api/overview | 全局概览：当前词书+进度、已掌握/错词/收藏/FSRS 到期/笔记数、累计学习时长 |
| GET /api/dicts | 词书列表 |
| GET /api/dicts/{id}/progress | 某词书进度 + 统计（totals 聚合 + statistics 原始数组） |
| GET /api/statistics | 学习统计（totals 汇总 + daily 按日聚合） |
| GET /api/words?filter=known\|wrong\|collect\|due | 按类型列单词（due=到期复习词） |
| GET /api/words/{word} | 单词详情：音标/翻译/例句 + flags{known,wrong,collect} + fsrs{due,state} + note |

### 写（操作数据）
| 接口 | 用途 | 请求体 |
|------|------|--------|
| POST /api/words/{word}/known | 标记/取消「已掌握」 | `{"value": true\|false}` 或省略（toggle） |
| POST /api/words/{word}/collect | 收藏/取消收藏 | 同上 |
| POST /api/words/{word}/note | 写/删笔记 | `{"note":"..."}`，空串删除 |

### 备份
| 接口 | 用途 |
|------|------|
| GET /api/export | 导出 dict + setting（JSON） |
| POST /api/import | 导入（body: `{"dict":{...},"setting":{...}}`） |

## 常见工作流

### 1. 查询学习进度
1. `GET /api/overview` → 读 `currentDict`（当前词书、progress 百分比）、`counts`、`study`。
2. 单本词书细节 → `GET /api/dicts/{id}/progress`。
3. 历史趋势 → `GET /api/statistics`（totals + daily）。

### 2. 获取到期复习词
`GET /api/words?filter=due` → 到期词列表（含 due、state、音标、翻译、note）。

### 3. 查询 / 操作单个单词
- 详情：`GET /api/words/{word}` → `flags` 判断状态、`note` 读笔记。
- 标记已掌握：`POST /api/words/{word}/known`。
- 收藏：`POST /api/words/{word}/collect`。
- 写笔记：`POST /api/words/{word}/note`（body `{"note":"..."}`）。

### 4. 备份 / 恢复
- 备份：`GET /api/export`，保存返回 JSON。
- 恢复：`POST /api/import`（body 为 export 的返回结构）。

## 响应约定

- 成功：直接返回资源 JSON；200 查询/更新、201 创建、204 删除。
- 失败：非 2xx + `{"statusCode":...,"statusMessage":"..."}`。
- 列表：`{items, total}`，支持 `?limit&offset`。
- 写操作幂等（重复调用无副作用）。

## 示例

```bash
# 健康检查
curl http://127.0.0.1:5567/api/health
# {"status":"ok","time":"..."}

# 全局进度
curl http://127.0.0.1:5567/api/overview

# 到期复习词
curl "http://127.0.0.1:5567/api/words?filter=due"

# 单词详情
curl http://127.0.0.1:5567/api/words/abandon

# 标记已掌握
curl -X POST http://127.0.0.1:5567/api/words/abandon/known \
  -H "Content-Type: application/json" -d '{"value":true}'

# 写笔记
curl -X POST http://127.0.0.1:5567/api/words/abandon/note \
  -H "Content-Type: application/json" -d '{"note":"我的笔记"}'
```

## 注意

- `overview.initialized` 为 false 表示服务端尚无词典数据（用户尚未打开页面一次，数据仍在浏览器 IndexedDB）。
- 409 表示数据未初始化，先让用户打开页面一次再操作。
- 设置 `API_TOKEN` 后，读写/备份接口需带 `Authorization: Bearer <token>`。
- 详细字段说明见《docs/API调用文档.md》。
