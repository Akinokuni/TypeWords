# 01 · Docker 部署

## 改动目标

用 Docker 把应用打包为自包含镜像，`docker compose up` 即可在本机/服务器运行；核心数据持久化到宿主机卷，重启不丢。

## 现状

- 部署方式为**静态托管**：`pnpm run generate` 生成 `.output/public`，再上传 Ali OSS（`scripts/deploy-oss.js`）或 EdgeOne Pages（`scripts/deploy-eo-pages.js`）。
- 无 `Dockerfile`、无 `docker-compose.yml`；已有 `.dockerignore`（需核对是否匹配新镜像）。
- `nuxt.config.ts` 中 `siteOrigin` 默认 `https://typewords.cc`，`devServer.port = 5567`。

## 方案（建议）

1. **多阶段构建**
   - 阶段一（构建）：`node:20-alpine`（或与项目 Node 版本一致），`pnpm install --frozen-lockfile` + `pnpm run build`。
   - 阶段二（运行）：`node:20-alpine`，复制 `.output`，`EXPOSE 5567`，`CMD ["node", ".output/server/index.mjs"]`。
2. **docker-compose.yml**
   - 服务名 `typewords`，端口映射 `5567:5567`（或自定义）。
   - 数据卷 `./data:/app/data`，用于挂载 SQLite/JSON 存储文件。
   - 环境变量：`PORT`、`NUXT_APP_BASE_URL`、`ORIGIN`、数据目录路径等。
3. **数据目录约定**：后端存储统一写到容器内 `/app/data/` → 宿主机 `./data/`（卷），与 02 文档的存储路径对齐。

## 涉及文件

- 新增 `Dockerfile`
- 新增 `docker-compose.yml`
- 修改 `.dockerignore`（核对 node_modules、.output、data 卷等）
- 可能调整 `nuxt.config.ts`（端口、origin、server 入口）
- 停用/保留 `scripts/deploy-oss.js`、`scripts/deploy-eo-pages.js`（作为历史参考）

## 状态

- 已完成（typecheck + dev 运行时验证通过）
- 已定：Node 24 镜像、端口 5567、数据目录 `/app/data`（宿主机 `./data`）
