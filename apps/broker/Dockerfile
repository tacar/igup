# IGUP broker — OAuth/Webhook中継サーバー。
# npm workspaces のロックファイルがリポジトリ直下にあるため、
# ビルドコンテキストはリポジトリルートを指定する:
#   docker build -f apps/broker/Dockerfile -t igup-broker .
#   (または apps/broker で docker compose up -d --build)
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/broker/package.json apps/broker/tsconfig.json ./apps/broker/
RUN npm ci --workspace @igup/broker
COPY apps/broker/src ./apps/broker/src
RUN npm run build -w @igup/broker

# 本番依存のみの node_modules を用意
FROM node:22-alpine AS proddeps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/broker/package.json ./apps/broker/
RUN npm ci --workspace @igup/broker --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV BROKER_DATA_DIR=/data
VOLUME /data
EXPOSE 8787
COPY --from=proddeps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/broker/dist ./dist
COPY --from=proddeps /repo/apps/broker/package.json ./package.json
CMD ["node", "dist/server.js"]
