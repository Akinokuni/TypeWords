---
name: typewords-api
description: 通过 TypeWords 在线服务查询学习进度、词书、统计、单词状态和到期复习内容；在用户明确要求时管理掌握、收藏、笔记、词书进度与设置，并支持增量同步与冲突处理。适用于 TypeWords 学习数据相关请求。
---

# TypeWords

使用 TypeWords 在线服务帮助用户查看和管理英语单词学习数据。

## 服务地址

固定使用：

`https://typewords.akinokuni.cn/`

所有接口路径均以 `/api` 开头。开始操作前，先请求 `GET /api/health` 确认服务可用；需要了解接口能力或字段时，可请求 `GET /api/openapi.json`。

若服务启用了 `API_TOKEN` 保护，除 `/api/health` 与内部接口 `/api/data/*`、`/api/ops*` 之外的 `/api/*` 都需带上请求头 `Authorization: Bearer <token>`（401 表示缺少或错误的 token）。

## 查询数据

| 接口 | 用途 |
|---|---|
| `GET /api/overview` | 查看当前词书、总体进度、掌握/错词/收藏/到期复习数量、笔记数和学习时长 |
| `GET /api/dicts` | 查看词书列表及各词书的基本进度 |
| `GET /api/dicts/{id}/progress` | 查看指定词书的详细进度和统计 |
| `GET /api/statistics` | 查看累计学习统计及按日趋势 |
| `GET /api/words?filter=known\|wrong\|collect\|due` | 按已掌握、错词、收藏或到期复习筛选单词 |
| `GET /api/words/{word}` | 查看单词的音标、翻译、例句、状态、复习信息和笔记 |
| `GET /api/ops?since={revision}` | 增量拉取变更日志（见「同步与并发」） |

列表接口支持 `limit` 与 `offset` 参数。向用户汇报时，优先使用易读的汇总信息，并保留关键数量和进度百分比。

## 修改数据

**只有在用户明确提出修改要求时**才调用写接口；不要根据查询结果自行改变学习数据。
结构调整、进度回退、导入覆盖这三类操作影响面较大，执行前必须先向用户复述将要发生的变化。

### 语义化写接口（推荐，语义清晰、自动幂等）

| 接口 | 用途 | 请求体 |
|---|---|---|
| `POST /api/words/{word}/known` | 标记或取消“已掌握” | `{"value": true}` 或 `{"value": false}`；省略请求体则切换状态 |
| `POST /api/words/{word}/collect` | 收藏或取消收藏 | 同上 |
| `POST /api/words/{word}/note` | 写入或删除笔记 | `{"note":"笔记内容"}`；空字符串删除笔记 |

响应形如 `{"word":"abandon","known":true,"changed":true,"revision":13}`：

- `changed: false` 表示该状态**本来就是目标状态**，服务端没有做任何修改，也不会产生变更记录——因此重复调用是安全的，可据此判断“是否真的改了”。
- `revision` 是服务端当前修订号，可作为后续写操作的基准或增量拉取的游标。
- 可传 `opId`（字符串）：服务端按它去重，网络重试不会产生第二次变更。

### 通用操作接口（能力更全）

需要调整进度、每日词量、词书结构、追加学习记录等语义化接口未覆盖的操作时使用：

```
POST /api/ops
{ "scope": "dict", "ops": [ { "opId": "...", "kind": "...", "payload": {...}, "baseRevision": 13, "origin": "agent" } ] }
```

响应：`{ "revision": 14, "applied": [{"opId":"...","revision":14,"changed":true}], "conflicts": [] }`

每个 `op` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `opId` | 是 | 全局唯一（建议 `agent-<时间戳>-<随机串>`），重复提交按幂等处理 |
| `kind` | 是 | 见下表 |
| `payload` | 是 | 见下表 |
| `baseRevision` | 建议 | 提交方看到的最后修订号；用于乐观并发校验（不填视为 0，可能被判冲突） |
| `origin` | 建议 | 填 `"agent"` 便于审计 |
| `clientTs` | 否 | ISO 时间，缺失时由服务端补 |
| `entityKeys` | 否 | 冲突域，服务端会自动推导，一般不用传 |
| `force` | 否 | 仅用于**显式覆盖单调值**（如进度回退），见下 |

支持的 `kind`（`list` 取值 `"word"`（默认，词书）或 `"article"`（文章书籍））：

| kind | payload | 说明 |
|---|---|---|
| `word.known.set` | `{word, value: boolean, full?}` | 标记/取消已掌握；**会同时把该词移出错词本** |
| `word.collect.set` | `{word, value: boolean, full?}` | 收藏/取消收藏 |
| `word.wrong.add` / `word.wrong.remove` | `{word, full?}` / `{word}` | 加入/移出错词本 |
| `word.note.set` | `{word, note}` | 写/删笔记；空字符串即删除，key 统一转小写 |
| `word.fsrs.set` | `{word, card}` | 写入记忆曲线卡片（`card` 为 ts-fsrs 结构，含 `due`/`state`/`reps` 等） |
| `word.fsrs.remove` | `{word}` | 删除记忆曲线卡片（通常标记已掌握后调用） |
| `dict.progress.set` | `{list?, dictKey, lastLearnIndex?, complete?}` | 学习进度；**默认只增不回退**，需回退时必须加 `force: true` |
| `dict.config.set` | `{list?, dictKey, patch: {perDayStudyNumber: 30}}` | 词书配置（每日词量等） |
| `dict.meta.set` | `{list?, dictKey, patch: {name?, description?, cover?}}` | 词书名/描述/封面 |
| `dict.statistics.push` | `{list?, dictKey, entries: [{id, startDate, spend, total, new, review, wrong}]}` | 追加学习记录；按 `id` 去重，只增不减 |
| `dict.add` | `{list, dict}` | 新增词书/书籍（`dict` 为完整对象，建议含 `id`/`name`/`length`） |
| `dict.remove` | `{list, dictKey}` | 从列表移除词书 |
| `dict.content.replace` | `{list, dictKey, words?}` 或 `{..., articles?}` | 整体替换词条/文章内容 |
| `study.index.set` | `{list, dictKey}` | 切换“当前学习”的词书 |
| `article.collect.set` | `{articleId, value, full?}` | 文章收藏/取消 |
| `setting.patch` | 需改的字段平铺，如 `{theme:"dark", wordReviewRatio:2}` | 设置项局部更新（`scope` 必须为 `"setting"`） |

`doc.replace` 与 `practice.session.set` 是服务端内部记账用的通知，**不要主动提交**。

`payload.full` 可选地传完整 Word 对象，让收藏/错词/已掌握列表里显示完整释义；不传也能生效（列表项可能只有单词本身）。

## 同步与并发

- **`revision` 是全局单调修订号**：每次有效写入 +1，并发写入通过它检测；写入单位是「操作」而非整份文档。
- **增量拉取**：`GET /api/ops?since=<revision>` 返回 `{revision, mode, ops[]}`；
  `mode: "snapshot-required"` 表示落后超过 500 条，改用 `GET /api/export` 全量同步；
  `ops[]` 每项含 `kind`/`payload`/`origin`/`revision`/`appliedAt`，可用于“这段时间用户都改了什么”。
- **乐观并发（冲突）**：当 `baseRevision` 落后、且**同一实体**已被别人改过时，该 op 不会被应用，
  而是出现在 `conflicts[]`：`{opId, kind, reason: "ENTITY_MODIFIED", serverRevision, conflictingOps[]}`。
  处理方式：重新 `GET /api/ops?since=` 拿到最新 `revision`，再以新 `baseRevision` 重投；
  若与用户意图相关（例如双方都改了同一个笔记或进度），应先向用户说明并让其决定，不要静默覆盖。
  实体不相交的并发写入不会冲突，可以直接提交。
- **实时通道**：`GET /api/ops/stream`（SSE）在有变更时推送 `{"scope":"dict","revision":N,"count":M}`，
  并把 `ping` 作为心跳；收到通知后再按 `since` 拉增量即可。长时间运行时可选。

## 数据语义（写入前需要知道的约定）

- 笔记 key 一律小写；`Abandon` 与 `abandon` 是同一篇笔记。
- 标记已掌握会连带把词移出错词本；取消已掌握**不会**把词加回错词本。
- 集合类数据（收藏/错词/已掌握）保证内容一致，但**数组顺序不保证**，比较时按单词集合比较。
- 官方词书的 `words` 不落库（服务端文档里该字段为空属正常），`length` 才是该词书总词数。
- 学习记录按 `id`（缺失时按内容指纹）去重，重复追加不会产生重复记录。

## 备份与恢复

- `GET /api/export`：导出学习数据。
- `POST /api/import`：导入导出的数据，请求体为 `{"dict":{...},"setting":{...}}`。
- `PUT /api/data/{key}`：**整文档覆盖写入**，仅用于初始化与显式导入，日常修改绝对不要用它。

导入与整文档写入会递增修订号并广播一次“文档替换”，其它在线客户端（包括用户正在练习的浏览器）会重新加载数据。除非用户明确要求恢复或导入，否则不要调用；调用前必须提醒用户先备份。

## 危险操作

| 操作 | 风险 | 要求 |
|---|---|---|
| `POST /api/import`、`PUT /api/data/*` | 整份数据被替换 | 用户明确要求 + 提醒备份 |
| `dict.remove`、`dict.content.replace` | 词书与词条丢失 | 先复述影响范围并确认 |
| `dict.progress.set` + `force: true` | 学习进度回退 | 明确告知将回退到第几词 |
| `word.fsrs.set` / `word.fsrs.remove` | 影响复习排程 | 仅在用户要求调整复习计划时使用 |

## 异常处理

- 非 2xx 响应通常包含 `statusCode` 与 `statusMessage`，应将可理解的错误原因告知用户。
- `400` 参数缺失或非法；`401` 需要 `Authorization` 头；`404` 词书/单词不存在；
  `409` 服务端还没有数据（先让用户打开网站初始化一次）或写操作冲突；
  `413` 单批 `ops` 超过 500 条（拆批提交）。
- 若概览中的 `initialized` 为 `false`，提示用户先打开 TypeWords 网站完成初始化后再重试。
- 若服务不可用，先报告健康检查失败，并保留接口返回的状态信息；不要臆测学习数据。
- 不要为了“确保生效”而盲目重试写操作：先看响应里的 `changed` 与 `conflicts` 再决定。

## 常用流程

### 查看学习进度

1. 请求 `/api/health`。
2. 请求 `/api/overview` 获取总体概览。
3. 用户指定词书时，再请求 `/api/dicts/{id}/progress`。
4. 用户需要趋势时，请求 `/api/statistics`。

### 查看到期复习词

请求 `/api/words?filter=due`，并向用户展示单词、释义、复习到期时间及已有笔记（如接口提供）。

### 查询或管理单词

先请求 `/api/words/{word}` 确认单词及当前状态，再按用户明确要求调用掌握、收藏或笔记接口；
根据响应中的 `changed` 告诉用户“已修改 / 本来就是该状态”。

### 调整学习进度或每日词量

1. `GET /api/overview` 或 `GET /api/dicts/{id}/progress` 拿到当前 `lastLearnIndex` 与修订号。
2. `POST /api/ops` 提交 `dict.config.set`（每日词量）或 `dict.progress.set`（进度）。
3. 进度回退必须带 `force: true`，并向用户确认目标位置。

### 追踪最近的变更

1. 从任意响应（或 `GET /api/ops?since=0`）取得当前 `revision`。
2. 之后用 `GET /api/ops?since=<上次的 revision>` 拉取增量；把新的 `revision` 存下来作为下次游标。
3. 若返回 `snapshot-required`，改用 `GET /api/export` 全量对比。

## 响应约定

- 成功的查询或更新通常返回 JSON 资源；创建可能返回 201，删除可能返回 204。
- 列表通常采用 `{items, total}` 结构。
- 所有写操作都幂等：重复提交同一操作（同 `opId`，或目标状态已一致）不会产生额外副作用。
- 写响应中的 `changed` 表示该请求是否产生了实际变更，`revision` 可用于后续乐观并发与增量同步。
