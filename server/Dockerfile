# ───────────── Stage 1: deps（安装 + 生成 prisma client）─────────────
FROM node:22-alpine AS deps
WORKDIR /app

# 阿里源加速（云托管推送节点在大陆）
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json* ./
# 先装完整 deps（含 prisma），生成 client 用的二进制
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

# ───────────── Stage 2: runtime（最小镜像）─────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    TZ=Asia/Shanghai

# 只装 prod deps；alpine 需要 libc6-compat + openssl 给 Prisma query engine 用
RUN apk add --no-cache libc6-compat curl tzdata openssl \
 && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 拷贝产物
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY src ./src
COPY prisma ./prisma

# 非 root 运行
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 -G nodejs nodejs \
 && chown -R nodejs:nodejs /app
USER nodejs

# 非 root 运行 → 端口必须 >1024（云托管 k8s 不给非特权用户绑 80）
EXPOSE 3000

# 云托管健康探测
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "src/index.js"]