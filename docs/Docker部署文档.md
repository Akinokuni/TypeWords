# TypeWords Docker 部署文档

私有化改造后的 TypeWords = Nuxt 前端 + Nitro server + SQLite 服务端存储，用 Docker 一键部署。

## 1. 前置要求

- Docker Engine 或 Docker Desktop（Windows / macOS / Linux）
- Docker Compose v2（随 Docker 一起提供）

## 2. 快速开始

在项目根目录执行：

```bash
docker compose up --build
```

首次会构建镜像（内含 `pnpm install` + `nuxt build`），完成后服务启动，默认监听 5567 端口。

浏览器打开 <http://127.0.0.1:5567> 即可使用。

> 后台运行：`docker compose up -d --build`

## 3. 端口与访问范围

`docker-compose.yml` 中端口默认映射为：

```yaml
ports:
  - "127.0.0.1:5567:5567"   # 仅本机可访问
```

- **仅本机访问**（默认，推荐）：保持 `127.0.0.1:5567:5567`。
- **局域网/外网访问**：改为 `"5567:5567"` 或 `"0.0.0.0:5567:5567"`。⚠️ 无认证，不要直接暴露公网；如需远程请加 `API_TOKEN`（见第 5 节）。

## 4. 数据持久化与备份

数据保存在 SQLite 单文件 `data/typewords.db`，通过数据卷挂载到宿主机：

```yaml
volumes:
  - ./data:/app/data
```

- **持久化**：容器重建/升级不丢数据（只要 `./data` 目录保留）。
- **备份**：
  1. 停止容器后直接复制 `data/typewords.db`；
  2. 或调用 `GET /api/export` 导出为 JSON（见《API调用文档》）。
- **恢复**：
  1. 停止容器，用备份文件覆盖 `data/typewords.db`；
  2. 或调用 `POST /api/import`。

> 首次打开页面时，浏览器里旧的 IndexedDB 数据会自动迁移到服务端 SQLite（一次性）。

## 5. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `5567` | 服务监听端口（改端口需同步改 compose 的 ports 映射） |
| `DATA_DIR` | `/app/data` | SQLite 数据文件目录 |
| `API_TOKEN` | 空（关闭） | 可选：设置后 Agent/管理接口需 `Authorization: Bearer <token>`；`/api/data/*` 与 `/api/health` 不校验 |

示例（在 `docker-compose.yml` 的 `environment` 中取消注释）：

```yaml
environment:
  API_TOKEN: "your-secret-token"
```

## 6. 验证部署

```bash
curl http://127.0.0.1:5567/api/health
# {"status":"ok","time":"..."}

curl http://127.0.0.1:5567/api/overview
# {"initialized":false}   （首次、尚无数据时）
```

## 7. 常用命令

```bash
docker compose up --build      # 构建并前台启动
docker compose up -d --build   # 构建并后台启动
docker compose logs -f         # 跟踪日志
docker compose ps              # 查看容器状态
docker compose restart         # 重启
docker compose down            # 停止并删除容器（保留数据卷）
docker compose down -v         # 停止并删除容器+数据卷（慎用，会删数据）
```

## 8. 排障

| 现象 | 原因 | 处理 |
|------|------|------|
| `unable to connect to the docker API at npipe://...dockerDesktopLinuxEngine` | Docker Desktop 未启动 | 启动 Docker Desktop，等就绪后再执行 |
| 端口被占用（`bind: address already in use`） | 5567 被占用 | 改 `PORT` 环境变量 + compose 端口映射 |
| 日志出现 `node:sqlite ... ExperimentalWarning` | Node 内置 sqlite 的实验性提示 | 无害，可忽略 |
| 首次 `up --build` 很慢 | 需下载依赖 + 构建 | 正常，后续构建有缓存会快很多 |

## 9. 不用 Docker 的本地运行（可选）

```bash
pnpm install
pnpm dev          # http://localhost:5567

# 生产方式
pnpm build
node .output/server/index.mjs
```

## 10. 架构速览

```
浏览器前端（Nuxt）
   │  HTTP /api/data/*（内部读写）
   ▼
Nitro server（server/api/*）
   │
   ▼
SQLite（data/typewords.db，宿主机卷 ./data）
   ▲
   │  REST API（/api/overview、/api/words、... 供 Agent 调用）
外部 Agent
```
