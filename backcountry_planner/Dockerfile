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
# Static, read-only park data ships with the image; the writable SQLite DB and elevation/route
# caches live on the Fly volume mounted at PERSIST_DIR instead (see fly.toml). This list must
# match backend/src/parks.ts's PARKS array exactly — it previously drifted (shipped 2 stale,
# renamed dataDirs left over from an early version, matching no currently-registered park at all)
# without anyone noticing, since a missing park here just makes that one park 400 at request time
# rather than failing the build. Since routing now lazy-loads each park's data on first request
# instead of eagerly at boot (see parkNetwork.ts's loadParkData / server.ts), boot no longer fails
# loudly for a missing park either — double-check this list against parks.ts when adding a park.
COPY backend/data/yellowstone-national-park-backcountry-permits ./data/yellowstone-national-park-backcountry-permits
COPY backend/data/grand-canyon-national-park-backcountry-permits ./data/grand-canyon-national-park-backcountry-permits
COPY backend/data/mount-rainier-national-park-wilderness-and-climbing-permits ./data/mount-rainier-national-park-wilderness-and-climbing-permits
COPY backend/data/north-cascades-national-park-backcountry-permits ./data/north-cascades-national-park-backcountry-permits
COPY backend/data/zion-national-park ./data/zion-national-park
COPY backend/data/sequoia-kings-canyon-national-parks ./data/sequoia-kings-canyon-national-parks
COPY backend/data/joshua-tree-national-park-wilderness-backpacking-permits ./data/joshua-tree-national-park-wilderness-backpacking-permits
COPY backend/data/sierra-national-forest ./data/sierra-national-forest
COPY backend/data/rocky-mountain-national-park-wilderness-permits ./data/rocky-mountain-national-park-wilderness-permits
COPY backend/data/grand-teton ./data/grand-teton
COPY backend/data/glacier ./data/glacier
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
