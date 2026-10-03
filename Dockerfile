# RIGGED production image: Vite-built client + Node server (SQLite on /app/data).
FROM node:22-slim AS build
# toolchain for better-sqlite3 when no prebuilt binary matches this Node version
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 RIGGED_DB_PATH=/app/data/rigged.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY server ./server
COPY src ./src
COPY prompts ./prompts
RUN mkdir -p /app/data
EXPOSE 8080
CMD ["node", "--import", "tsx", "server/index.ts"]
