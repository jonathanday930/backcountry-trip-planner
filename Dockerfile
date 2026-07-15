# syntax=docker/dockerfile:1

# ---- frontend build ----
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend build (compiles TypeScript; native deps built here too) ----
FROM node:20-bookworm-slim AS backend-build
# better-sqlite3 has no prebuilt binary for this platform, so it compiles from source via
# node-gyp, which needs Python and a C++ toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
ENV NODE_ENV=production

# Install only production dependencies (compiles better-sqlite3's native binary for this image).
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=backend-build /app/backend/dist ./dist
# Static, read-only park data ships with the image; the writable SQLite DB and elevation cache
# live on the Fly volume mounted at PERSIST_DIR instead (see fly.toml).
COPY backend/data/grand-canyon ./data/grand-canyon
COPY backend/data/rocky-mountain ./data/rocky-mountain
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
