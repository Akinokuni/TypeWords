# TypeWords API 调用文档

供外部 Agent（或脚本）读取学习进度、操作数据的 REST API 说明。

## 1. 基本信息

- Base URL：`http://127.0.0.1:5567`（或你的部署地址）
- 风格：标准 REST + JSON
- 认证：默认无认证；若设置了 `API_TOKEN`，见第 3 节
- 可用性检查：`GET /api/health`；自动发现：`GET /api/openapi.json`

## 2. 通用约定

### 2.1 成功响应
直接返回资源 JSON，用 HTTP 状态码区分语义：
- `200` 查询成功 / 更新成功
- `201` 创建成功
- `204` 删除成功（无响应体）

### 2.2 失败响应
非 2xx 状态码 + JSON 错误体（h3 标准格式）：

```json
{"statusCode": 404, "statusMessage": "dict not found"}
```

### 2.3 列表与幂等
- 列表接口支持 `?limit&offset`，返回 `{items, total}`。
- 写操作幂等（按唯一键 upsert，重复调用不产生副作用）。

## 3. 认证（可选 API_TOKEN）

- 未设置 `API_TOKEN`（默认）：所有接口无需认证。
- 设置了 `API_TOKEN`：以下「Agent/管理接口」需请求头 `Authorization: Bearer <token>`：
  - `/api/overview`、`/api/dicts*`、`/api/statistics`、`/api/words*`、`/api/export`、`/api/import`
- 以下接口不校验 token（内部/健康检查）：
  - `/api/health`、`/api/openapi.json`、`/api/data/*`

```bash
curl -H "Authorization: Bearer your-token" http://127.0.0.1:5567/api/overview
```

## 4. 接口清单

### 4.1 元信息
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/openapi.json` | OpenAPI 描述（Agent 自动发现） |

### 4.2 进度 / 统计（读）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/overview` | 全局学习概览 |
| GET | `/api/dicts` | 词书列表 |
| GET | `/api/dicts/:id/progress` | 某词书进度 + 统计 |
| GET | `/api/statistics` | 学习统计（含按日聚合） |

### 4.3 单词（读）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/words?filter=known|wrong|collect|due` | 按类型列单词 |
| GET | `/api/words/:word` | 单词详情 |

### 4.4 数据操作（写）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/words/:word/known` | 标记/取消「已掌握」 |
| POST | `/api/words/:word/collect` | 收藏/取消收藏 |
| POST | `/api/words/:word/note` | 写/删单词笔记 |

### 4.5 备份 / 导入
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/export` | 导出全量数据（dict + setting） |
| POST | `/api/import` | 导入数据 |

### 4.6 内部读写（前端使用，一般 Agent 不需要）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET / PUT | `/api/data/dict` | 词典数据（value 为 JSON 字符串） |
| GET / PUT | `/api/data/setting` | 设置数据（value 为 JSON 字符串） |

## 5. 接口示例

### 5.1 健康检查
```bash
curl http://127.0.0.1:5567/api/health
```
```json
{"status":"ok","time":"2026-08-24T16:08:07.880Z"}
```

### 5.2 全局概览
```bash
curl http://127.0.0.1:5567/api/overview
```
```json
{
  "initialized": true,
  "currentDict": {"id":"demo","name":"Demo","length":2,"lastLearnIndex":1,"perDayStudyNumber":10,"progress":50},
  "counts": {"known":1,"wrong":1,"collect":0,"fsrsCards":1,"fsrsDue":1,"notes":1},
  "study": {"totalSpendMs":60000,"totalSpendMinutes":1},
  "setting": null
}
```
字段含义：`currentDict` 当前词书与进度；`counts` 已掌握/错词/收藏/FSRS 卡片数/到期数/笔记数；`study` 累计学习时长。

### 5.3 词书列表
```bash
curl http://127.0.0.1:5567/api/dicts
```
返回 `{items:[{id,enName,name,length,lastLearnIndex,perDayStudyNumber,complete,wordCount,progress,...}], total}`。

### 5.4 词书进度
```bash
curl http://127.0.0.1:5567/api/dicts/demo/progress
```
返回该词书的 `progress`、`lastLearnIndex`、`totals`（spendMs/wrong/new/review/total/sessions）与原始 `statistics` 数组。

### 5.5 学习统计
```bash
curl http://127.0.0.1:5567/api/statistics
```
```json
{
  "totals": {"spendMs":60000,"wrong":2,"new":5,"review":5,"total":10,"sessions":1},
  "daily": [{"date":"2024-08-24","spendMs":60000,"wrong":2,"new":5,"review":5,"total":10,"sessions":1}]
}
```

### 5.6 单词列表（按类型）
```bash
curl "http://127.0.0.1:5567/api/words?filter=wrong"
```
`filter` 可选：`known`（已掌握）/ `wrong`（错词）/ `collect`（收藏）/ `due`（到期复习词）。返回 `{items:[{word,phonetic0,phonetic1,trans:[{pos,cn}]}], total}`（`due` 额外含 `due`/`state`/note）。

### 5.7 单词详情
```bash
curl http://127.0.0.1:5567/api/words/abandon
```
```json
{
  "word":"abandon","found":true,
  "phonetic0":"","phonetic1":"",
  "trans":[{"pos":"v.","cn":"abandon-cn"}],
  "sentences":[],"phrases":[],
  "flags":{"known":false,"wrong":true,"collect":false},
  "fsrs":{"word":"abandon","due":"2020-01-01","state":2},
  "note":"my note"
}
```

### 5.8 标记已掌握 / 收藏 / 笔记（写）
```bash
# 标记已掌握（body.value 不传则自动 toggle；传 true 强制加，false 强制删）
curl -X POST http://127.0.0.1:5567/api/words/abandon/known \
  -H "Content-Type: application/json" -d '{"value":true}'
# 响应：{"word":"abandon","known":true}

# 收藏 / 取消收藏
curl -X POST http://127.0.0.1:5567/api/words/abandon/collect \
  -H "Content-Type: application/json" -d '{"value":true}'

# 写笔记（note 为空串则删除笔记）
curl -X POST http://127.0.0.1:5567/api/words/abandon/note \
  -H "Content-Type: application/json" -d '{"note":"我的笔记"}'
```

### 5.9 导出 / 导入
```bash
curl http://127.0.0.1:5567/api/export   # {"dict":{...},"setting":{...}}

curl -X POST http://127.0.0.1:5567/api/import \
  -H "Content-Type: application/json" -d '{"dict":{...},"setting":{...}}'
```

## 6. 错误码

| HTTP 状态 | 含义 |
|-----------|------|
| 400 | 参数缺失/非法（如 filter 未提供、缺 value） |
| 401 | 未认证（设置了 API_TOKEN 但未带/带错 Authorization） |
| 404 | 资源不存在（词书/单词未找到） |
| 409 | 数据未初始化（服务端还没有词典数据，先打开页面一次） |
| 500 | 服务端内部错误 |

## 7. Agent 对接建议

1. 启动后先 `GET /api/health`（或 `/api/openapi.json`）做可用性检查与工具注册。
2. 用 `/api/overview` 拿全局进度，`/api/dicts/:id/progress` 拿单本词书进度，`/api/statistics` 拿学习统计。
3. 用 `/api/words?filter=due` 拿到期复习词，`/api/words/:word` 拿单词详情与标记。
4. 写操作用 `POST /api/words/:word/{known|collect|note}`，幂等，可安全重试。
5. 若设置了 `API_TOKEN`，所有 Agent 请求头带 `Authorization: Bearer <token>`。
