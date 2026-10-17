# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A backcountry trip planner: pick a national park/forest, click campsites or
any point on the map, and get on-trail (not straight-line) distance and
elevation gain/loss between stops, with Google sign-in and saved multi-day
routes. `frontend/` is React + Vite + Leaflet; `backend/` is Express +
TypeScript with a SQLite database (users/sessions/saved routes) and a
from-scratch routing/elevation engine over downloaded OpenStreetMap +
USGS data (no external routing or elevation API is called at request time
for any park that's been fully set up; see "The routing/elevation engine"
below).

## Commands

```bash
# Install (from repo root)
cd backend && npm install
cd ../frontend && npm install

# Day-to-day dev: run both, each in its own terminal
cd backend && npm run dev     # tsx watch, http://localhost:3001 (API only)
cd frontend && npm run dev    # vite, http://localhost:5173 (proxies /api to :3001, open this one)

# Typecheck (run from backend/ or frontend/, no separate lint script in either)
npx tsc -p tsconfig.json --noEmit   # backend
npx tsc -b --noEmit                 # frontend

# Backend tests (vitest, no test files currently exist in the repo)
cd backend && npm test

# Production-mode local test: backend serves the built frontend from one port (:3001, not :5173)
cd frontend && npm run build && cd ../backend && npm run build && node dist/server.js

# Docker
docker build -t backcountry-planner .
docker run -p 3001:3001 -e PERSIST_DIR=/tmp/data backcountry-planner

# Deploy (Fly.io, Dockerfile + fly.toml already configured)
fly deploy
```

Elevation/park-data pipeline commands (fetching a new park, downloading its
elevation raster, etc.) are documented in `backend/scripts/README.md`, read
that before touching anything under `backend/scripts/` or
`backend/src/scripts/`, it has hard-won gotchas that aren't obvious from the
code alone.

## Architecture

### The routing/elevation engine (the core of this app)

This is not a thin wrapper around a mapping API: trail/road networks and
elevation are both self-hosted, built once per park and read locally at
request time.

1. **`backend/src/graph.ts`**: builds an in-memory graph from a park's
   `trails.geojson` + `roads.geojson` (roads are just as walkable as
   trails, tagged `kind: 'road'` only so the frontend can style them
   differently). Handles junction-merging across separately-digitized OSM
   ways, manual per-park connectors for real gaps the source data doesn't
   capture (a river crossing, a trailhead parking gap, see
   `MANUAL_CONNECTORS`), and snapping both campsites and arbitrary
   map-clicked points onto the network. `shortestPath` is Dijkstra with a
   binary min-heap; it used to be a plain sorted array and **hard-hung on
   graphs over ~60k edges**; if routing on a large park ever seems to hang,
   check this hasn't regressed before looking anywhere else.
2. **`backend/src/parkNetwork.ts`**: the shared "load one park's
   campsites/trails/roads/zones and build its graph" function; both
   `server.ts` (at boot, for all registered parks) and the DEM fetch script
   use this so they can never drift on how a graph is assembled.
3. **`backend/src/elevation.ts`**: given a path's edges, samples elevation
   every ~50m along each edge and reduces to gain/loss. Elevation for a
   given point comes from a park's local DEM raster if one has been fetched
   (`backend/src/demElevation.ts` + `backend/src/dem/`), falling back to a
   live USGS EPQS point query (cached per-coordinate to disk) for a park
   that doesn't have one yet. **Gain/loss is not a naive sum of every
   up/down step**: a hysteresis/minimum-prominence filter runs over the
   whole route's concatenated elevation profile first (a small reversal
   spanning an edge boundary wouldn't be visible from either edge's own
   isolated samples, which is why this happens in `computeRouteElevation`
   rather than being cached per-edge). The filter's `(smoothWindow,
   threshold)` is tuned per park via `PARK_FILTER_CONFIG`, and — for the
   rarer case where one specific trail corridor needs different tuning than
   the rest of its park (a real ceiling of a single park-wide config, not a
   tuning oversight) — per-corridor via `CORRIDOR_FILTER_CONFIG` (a
   geographic bounding box override, not keyed by stop ids, so it applies
   to anyone routing through that stretch of trail). See
   `backend/scripts/README.md` for the full story on why this filter
   exists and how its thresholds were chosen; both are calibrated against
   real discrepancies found in production, not a guess, using
   `backend/src/scripts/sweepElevationFilter.ts` and
   `testing/README.md`'s "Tuning the elevation filter" /
   "Per-corridor filter overrides" sections.
4. **`backend/src/scripts/fetchDem.ts`**: downloads a park's elevation
   raster from USGS's public 3DEP service once, converted to a compact
   local format. **Read `backend/scripts/README.md`'s "Elevation data"
   section before touching this**, it documents a serious silent
   data-corruption bug (Int16 overflow above 3276.7m elevation, which
   corrupted 7 of the first 11 parks) and the verification script
   (`scanDemCorruption.ts`) that must be run after every fetch.

### Request flow

`GET /api/route?park=<id>&stops=<a>|<b>|...` (`backend/src/server.ts`):
each stop is either a known campsite id or a raw `"lat,lon"` the frontend
sends for a map-clicked point. Resolves each stop to a graph node
(snapping raw points on the fly via `attachPointToNetwork`), runs
`shortestPath` leg by leg, computes elevation per leg, and returns per-leg
`coordinates` alongside the totals; the frontend uses those to color each
day of a multi-day trek separately once the user marks overnight stops.

### Data layout (`backend/data/<parkDataDir>/`)

Per park: `campsites.json`, `trails.geojson`, `roads.geojson`, optionally
`zones.geojson` (backcountry zone/permit-area boundaries) and `dem/`
(the local elevation raster + manifest, once fetched). Park `id` (used in
the frontend URL) and `dataDir` (the folder name) are deliberately allowed
to differ, see `backend/src/parks.ts`, which is the single registry new
parks are added to. `backend/scripts/README.md` documents the full
provenance: campsites/trailheads/closures come from Recreation.gov's permit
API (`backend/scripts/scrape-*.ts`), trails/roads from OpenStreetMap via
Overpass (`backend/scripts/build-park-network.ts`), elevation from USGS
3DEP (`backend/src/scripts/fetchDem.ts`).

Two more optional per-park files feed the chat agent (see "Trip-planning
chat agent" below), both read at tool-call time, never bundled into
`campsites.json` itself: `known-routes.json` (curated real named routes,
each just a list of real stop ids, no baked-in mileage) and
`permit-divisions.json` (maps a campsite's app-facing id to Recreation.gov's
own numeric division id, needed to query live permit availability). A park
with neither file simply has those two chat capabilities degrade to "not
available for this park" rather than erroring.

Note the two separate scripts directories: `backend/scripts/` (data
acquisition: scraping, OSM fetching, zone-building) vs
`backend/src/scripts/` (elevation raster fetching/verification, compiled
alongside the rest of the backend). `backend/scripts/README.md` covers
both and is the authoritative source for "how do I bring in a new park."

### Trip-planning chat agent (`backend/src/chat.ts`)

`POST /api/chat` is a tool-calling agent, not a plain Q&A wrapper: it can
call real tools (weather, permit availability, trail closures, curated
known routes, a multi-night mileage-split solver) before answering, instead
of guessing from training data alone.

1. **`backend/src/chat.ts`**: the HTTP endpoint. Builds the system prompt
   (park name, current route summary, today's date so the model can resolve
   "next weekend" itself, and guidance on when to use which tool) and hands
   it to `llm.ts`. Trims incoming history server-side regardless of what the
   client sends (`MAX_HISTORY_TURNS`) as a cost/abuse guard. Conversation
   history itself is not persisted anywhere server-side: the frontend
   (`frontend/src/ChatWidget.tsx`) resends the full turn history on every
   request, and that's the only copy that exists.
2. **`backend/src/llm.ts`**: picks which model provider actually answers,
   via the `LLM_PROVIDER` env var (`anthropic`, the default, or
   `huggingface`). This is the one file that knows a provider switch
   exists; every provider module below implements the same
   `ChatCompletionRequest -> ChatCompletionResult` signature
   (`backend/src/llmProviders/types.ts`), so `chat.ts` and the frontend
   never need to change when switching. See `backend/.env.example` for the
   full list of provider-specific env vars (`CHAT_MODEL`/`CHAT_MAX_TOKENS`
   for Anthropic; `HF_TOKEN`/`HF_MODEL` for Hugging Face) — that file is
   the source of truth for what to set, keep it in sync if you add a
   provider.
3. **`backend/src/llmProviders/anthropic.ts`** and **`huggingface.ts`**:
   each runs its own manual tool-calling loop (not the Anthropic SDK's
   beta Tool Runner, deliberately — this needs per-tool duration tracking
   for the frontend's activity chips, a per-tool try/catch that turns a
   thrown error into an error result the model can react to instead of
   aborting the whole turn, and a hard iteration cap, none of which the
   Tool Runner exposes as cleanly). The two loops are functionally
   identical; they only differ in how each provider's API wants tool calls
   phrased (Anthropic's `tool_use`/`tool_result` content blocks vs. the
   Hugging Face path's OpenAI-compatible `tool_calls`/`role: 'tool'`
   messages, since Hugging Face's Inference Providers router speaks the
   `openai` SDK's dialect). **Known real-world gap, not a bug**: Anthropic's
   Claude models are specifically trained to be reliable about *when* to
   call a tool and how to format the call; open models (the Hugging Face
   path's current default is Llama 3.3 70B) are generally less consistent
   at that judgment call industry-wide, so don't assume parity in tool-use
   quality just because both paths are wired up correctly.
4. **`backend/src/tools/index.ts`**: the single source of truth for every
   tool's name, description, and input shape (`TOOLS`), plus the dispatcher
   (`executeTool`) both provider loops call into — a tool is written once
   here and is automatically available on both providers.
   **`backend/src/tools/toOpenAiTools.ts`** reshapes `TOOLS` into the
   OpenAI-compatible function-calling format for the Hugging Face path;
   never hand-duplicate a tool's schema there.
5. The tools themselves: `itinerarySolver.ts` (deterministic, no network —
   given an ordered real corridor of stops and a daily mileage cap, finds
   the best way to split it across a given number of nights via the same
   `buildRouteSubgraph` `/api/route` itself uses, so results can't drift
   from what the app would show); `tools/weather.ts` (api.weather.gov, no
   key needed); `tools/closures.ts` (for parks with an `npsParkCode` set in
   `parks.ts`, calls the National Park Service's own structured alerts API —
   real closures/hazards, no scraping, requires `NPS_API_KEY`; other parks
   fall back to fetching the park's own conditions page as plain text — see
   the doc comment there for a confirmed real limitation of that fallback:
   some parks' actual per-trail closure list only renders through a
   client-side map widget a plain fetch can't see, so it can fall back to
   general seasonal-hazard text rather than live per-trail status. National
   forests, BLM land, and other non-NPS units have no equivalent shared
   feed, so they stay on the page-scrape fallback);
   `tools/knownRoutes.ts` (reads a park's curated `known-routes.json`,
   computes live mileage); `tools/permitAvailability.ts` (Recreation.gov's
   own public per-division JSON endpoint — found by capturing network
   traffic behind their availability page rather than driving it as a
   browser, so this needs no headless browser at all — cached in SQLite for
   6 hours per division since group size/starting-area don't factor into
   that endpoint at all).

### Map hazard layer (`backend/src/hazards.ts`, National Park Service parks only)

`GET /api/hazards?park=<id>` powers a map layer of clickable hazard/closure
icons, separate from the chat agent's `get_trail_closures` tool above
(though both pull from the same NPS feeds via `backend/src/npsApi.ts`,
which now holds the shared `fetchNpsAlerts`/`fetchNpsRoadEvents` fetch
logic `tools/closures.ts` used to own alone). Two NPS feeds, two very
different shapes:

- **Road events** (`fetchNpsRoadEvents`) carry real geometry, so these
  become map pins directly, at their own reported location. Confirmed
  live (Mount Rainier, 2026-09-08): the feed follows the WZDx (Work Zone
  Data Exchange v4.1) standard — the response body itself *is* one
  GeoJSON `FeatureCollection`, not a `{ data: [...] }` wrapper, and each
  feature's real fields are `properties.Id`,
  `properties.core_details.{name, description, road_names, event_type}`,
  and `properties.vehicle_impact` (mapped onto the same
  Park Closure/Caution/Information vocabulary `/alerts` uses).
- **Alerts** (`fetchNpsAlerts`) are official but carry no coordinates of
  their own — confirmed live. Some alerts do carry an official link
  though: `relatedRoadEventTitles`, whose *titles* (not ids — confirmed
  live that the id on this field doesn't match the road event's own `Id`)
  reliably exact-match a `fetchNpsRoadEvents` feature's title. `hazards.ts`
  checks this link first and pins the alert straight at that road event's
  location when it's there (official, no guessing). Failing that,
  `hazardLocator.ts` makes a small, cheap Hugging Face model call (a
  single-shot classification, not a chat — separate model/env var,
  `HAZARD_LOCATOR_MODEL`, from the chat widget's `HF_MODEL`) that reads
  the alert and, only when it confidently names a place already in this
  park's data (a campsite/trailhead or a uniquely-named trail, built in
  `hazards.ts`'s `buildLocationCandidates`), returns that place's id so
  the alert can be pinned there — tagged `source: 'alert-match'` end to
  end so the frontend popup always labels it as an approximate,
  machine-matched location, never an official one. An alert with neither
  kind of match (or if `HF_TOKEN` is unset, in which case the AI-matching
  step is skipped entirely) goes in the response's `unlocated` list
  instead of being guessed onto the map.

Both feeds are fetched together and cached in-memory per park for 30
minutes (`hazards.ts`'s own `Map`, not the SQLite cache
`permit_availability_cache` uses — this data doesn't need to survive a
restart, so the simpler in-memory approach was enough). Parks without an
`npsParkCode` get an empty result rather than an error, so the frontend
can call this endpoint unconditionally, the same as `/api/zones`.

Frontend side (`PlannerPage.tsx`): hazard pins use their own marker shape
(`hazardIcon`, a warning triangle — distinct from the round campsite
markers) colored by category via `HAZARD_COLORS`, same
color-by-category/legend pattern `TYPE_COLORS`/`TYPE_LABELS` already use
for campsites. Unlocated alerts show in a toggleable "Park Alerts" panel
(`.park-alerts-control`) instead of a guessed pin.

### Persistence (`backend/src/db.ts`)

SQLite via better-sqlite3, at `PERSIST_DIR/app.db` (defaults to
`backend/data/`, overridden in production to point at a Fly.io volume so it
survives deploys). Four tables: `users`, `sessions` (Google OAuth,
`backend/src/auth.ts`), `saved_routes` (park id + ordered stop ids +
`sleep_stops` marking which via-stops are overnight stays, for multi-day
route coloring, `backend/src/savedRoutes.ts`), `permit_availability_cache`
(the chat agent's 6-hour live-permit-availability cache, keyed by
park+permit+division). Schema migrations are hand-rolled inline in `db.ts`
(check-then-`ALTER TABLE`), not a migration framework.

### Frontend

Two routes only (`frontend/src/App.tsx`): `/` (`HomePage.tsx`) and
`/park/:parkId` (`PlannerPage.tsx`, where essentially all the actual
functionality lives: map, stop search/selection, day-by-day trip
breakdown, saved routes panel). Vite proxies `/api/*` to the backend in
dev (`frontend/vite.config.ts`); in production the backend serves the
built frontend directly from the same origin (see `server.ts`'s
`FRONTEND_DIST` check), so there's no separate frontend deploy target.

### Accuracy validation (`testing/`)

A standalone harness, untracked by git and with its own `package.json`
(Playwright only) separate from `backend`/`frontend`, that checks our
routing/elevation numbers against Komoot's public route planner for a
fixed set of real routes (`testing/test-routes.json`). `komoot-lib.mjs`/
`komoot-lookup.mjs` drive Komoot's site via Playwright (it has no public
API) to get its distance/gain/loss per leg, `fetch-ours.mjs` hits our own
`/api/route` for the same legs, and `build-report.mjs` merges both into
`comparison-report.md` with a percent-off column per leg. Not wired into
either package's `npm test`, run it by hand after changing `elevation.ts`
or `graph.ts` in a way that could shift distances or gain/loss, not on
every change. `backend/src/scripts/sweepElevationFilter.ts` and
`diagnoseRoutingGap.ts` are the tuning/diagnostic tools for when this
harness turns up a real discrepancy — see `testing/README.md` for the full
methodology (routing gaps, park-wide and per-corridor filter tuning, and
when a leg genuinely isn't fixable and should be restructured instead).
