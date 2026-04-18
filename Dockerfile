# 全局参数
ARG NODE_VERSION=22

# ==========================================
# 第一阶段：构建前端 (Frontend Build)
# ==========================================
FROM node:${NODE_VERSION}-alpine AS frontend-build
WORKDIR /app

# 复制前端依赖文件并安装
COPY package.json package-lock.json ./
RUN npm install

# 复制前端源代码及构建配置
COPY src/ ./src/
COPY index.html tsconfig.json vite.config.ts tailwind.config.js postcss.config.js ./

# 执行前端构建
RUN npm run build

# ==========================================
# 第二阶段：生产运行环境 (Production Runtime)
# ==========================================
FROM node:${NODE_VERSION}-alpine AS production
WORKDIR /app

# 仅需 curl 用于健康检查 (方舟官方 API 模式无需浏览器代理)
RUN apk add --no-cache curl

# 复制后端依赖文件并安装（仅生产依赖）
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm install --production

# 复制后端代码
COPY server/index.js ./server/
COPY server/database/ ./server/database/
COPY server/services/ ./server/services/

# 从第一阶段复制前端构建产物
COPY --from=frontend-build /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD curl -f http://localhost:3001/api/health || exit 1

CMD ["node", "server/index.js"]
