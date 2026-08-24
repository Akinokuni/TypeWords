# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@11.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=5567 \
    DATA_DIR=/app/data
COPY --from=build /app/.output ./.output
EXPOSE 5567
VOLUME ["/app/data"]
CMD ["node", ".output/server/index.mjs"]
