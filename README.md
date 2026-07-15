# Backcountry Trip Planner

On-trail distance/elevation planning for national park backcountry trips, with saved routes and
Google sign-in.

- `frontend/` — React + Vite + Leaflet
- `backend/` — Express + TypeScript, SQLite (via better-sqlite3), Google OAuth

## Local development

Requires Node 20+.

```bash
cd backend && npm install
cd ../frontend && npm install
```

Copy `backend/.env.example` to `backend/.env` and fill in Google OAuth credentials if you want
sign-in to work locally (optional — everything except login/saved routes works without it). See
"Google OAuth setup" below.

Run both dev servers, each in its own terminal:

```bash
cd backend && npm run dev    # http://localhost:3001 (API only)
cd frontend && npm run dev   # http://localhost:5173 (proxies /api to :3001)
```

Open **http://localhost:5173**. This is the normal day-to-day workflow — Vite's dev server gives
you hot reload, and it proxies `/api/*` requests to the backend.

### Testing the production setup locally (optional)

The backend can also serve the built frontend directly from one port — this is what actually
runs in production, so it's worth testing before deploying:

```bash
cd frontend && npm run build   # writes frontend/dist
cd ../backend && npm run build # writes backend/dist
node dist/server.js            # now serving both API and frontend on :3001
```

Visit **http://localhost:3001** directly (not 5173) to see this mode. Delete `frontend/dist` and
`backend/dist` afterward (or just re-run `npm run dev` in each) to go back to normal two-server
local dev — the backend automatically detects whether `frontend/dist` exists and switches modes.

### Testing the Docker image locally (optional)

```bash
docker build -t backcountry-planner .
docker run -p 3001:3001 -e PERSIST_DIR=/tmp/data backcountry-planner
```

If you don't have Docker Desktop, [colima](https://github.com/abiosoft/colima) is a lightweight
alternative (`brew install docker colima && colima start`).

## Deploying to Fly.io

This repo already has a `Dockerfile` and `fly.toml` configured — multi-stage build (frontend
static build + compiled backend), single process serving both, with a persistent volume for the
SQLite database and elevation cache (everything else — trail/campsite data — ships in the image
and is read-only).

1. Install the CLI and log in:
   ```bash
   brew install flyctl
   fly auth login
   ```

2. Register the app (reuses the committed `fly.toml`; change the `app` name in `fly.toml` first
   if `backcountry-trip-planner` is already taken):
   ```bash
   fly apps create backcountry-trip-planner
   ```

3. Create the persistent volume for the database/elevation cache (name and region must match
   `fly.toml`):
   ```bash
   fly volumes create backcountry_data --region iad --size 1
   ```

4. Set secrets — `FRONTEND_URL` and `GOOGLE_REDIRECT_URI` should point at your app's real
   `https://<app-name>.fly.dev` hostname (or a custom domain once you set one up):
   ```bash
   fly secrets set \
     GOOGLE_CLIENT_ID=xxx \
     GOOGLE_CLIENT_SECRET=xxx \
     GOOGLE_REDIRECT_URI=https://backcountry-trip-planner.fly.dev/api/auth/google/callback \
     FRONTEND_URL=https://backcountry-trip-planner.fly.dev
   ```

5. Deploy:
   ```bash
   fly deploy
   ```

6. In [Google Cloud Console](https://console.cloud.google.com/), add the production callback URL
   as an **additional** authorized redirect URI on your OAuth client (keep the localhost one too,
   so both environments keep working):
   ```
   https://backcountry-trip-planner.fly.dev/api/auth/google/callback
   ```

After the first deploy, `fly deploy` is all you need for subsequent updates.

## Google OAuth setup

Needed for sign-in/saved routes, both locally and in production:

1. In [Google Cloud Console](https://console.cloud.google.com/), create an OAuth consent screen
   (External is fine) and a **Web application** OAuth client under Credentials.
2. Add authorized redirect URIs for every environment you use:
   - `http://localhost:5173/api/auth/google/callback` (local dev)
   - `https://<your-app>.fly.dev/api/auth/google/callback` (production)
3. Put the client ID/secret in `backend/.env` (local) and `fly secrets set` (production) — see
   `backend/.env.example` for the full list of variables.
