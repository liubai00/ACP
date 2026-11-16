# ACP 任务榜（board）镜像：构建静态文件，由 nginx 提供，SPA 回退到 index.html。
# API（/api /auth /a2a /mcp /.well-known /healthz）由前面的 Caddy 转发给 coordinator，这里不代理。

# ---------- 构建 ----------
FROM node:22-alpine AS build
# deploy/compose.yaml 会传入；国内网络可改成 https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY --no-audit --no-fund

COPY . .
RUN npm run build

# ---------- 运行 ----------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
