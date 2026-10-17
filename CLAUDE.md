# claude_projects

This directory holds multiple independent projects, each in its own
subdirectory with its own git history/tooling. Use this file to find the
right subdirectory before digging further — don't assume top-level paths
like `backend/` or `frontend/` exist here directly; they're one level down.

## backcountry_planner/

A backcountry trip planner (national parks/forests: pick campsites or any
map point, get on-trail distance + elevation gain/loss, with a from-scratch
routing/elevation engine over downloaded OSM + USGS data). This is the
active, developed project here.

**Always read `backcountry_planner/CLAUDE.md` first** — it's the
authoritative architecture doc (routing/elevation engine, request flow,
data layout, persistence, frontend structure) and is kept current. Once
you're oriented, the deeper references it points to:

| Doc | Covers |
|---|---|
| `backcountry_planner/CLAUDE.md` | Architecture, commands, how the pieces fit together — start here |
| `backcountry_planner/backend/scripts/README.md` | Bringing in a new park end-to-end (scraping, OSM trail/road fetch, zone polygons, **scanned zone-map overlays incl. the icon-vs-label correspondence-point gotcha**), elevation DEM fetching + the Int16 corruption bug, dev-server process gotchas |
| `backcountry_planner/testing/README.md` | Accuracy validation against Komoot, **diagnosing/fixing routing gaps (incl. tracing missing trail geometry from a park's overlay map when a straight `MANUAL_CONNECTORS` edge isn't enough)**, elevation-filter tuning (park-wide and per-corridor) |

Worth knowing about, not part of the doc set above:
`backcountry_planner/backend/data/` (per-park scraped data + local DEM
rasters, large), `backcountry_planner/testing/` (its own `package.json`,
Playwright-driven, not wired into either `npm test`).

## youtube_fact_checker/

A web app that checks whether a stock/crypto YouTube video's predictions came
true: paste a link, Claude extracts the video's falsifiable market
predictions from its transcript, then judges each one against real
historical price data (via `yfinance`) and produces an overall trustworthiness
verdict. Stateless (no database) — Python/FastAPI backend, React/Vite/TS
frontend, deployed to Fly.io.

**Always read `youtube_fact_checker/CLAUDE.md` first** — it's the
authoritative architecture doc (the three-endpoint request flow, model
choice per pass, ticker-resolution logic, why the summary is computed in
code rather than by a third Claude call) and is kept current.

## analyst-audit/

A track-record system for finance "gurus" (YouTube channels, blogs): extracts every
falsifiable claim a guru makes, checks over time whether it panned out, and rolls that up into
a per-guru reliability score. Sibling to `youtube_fact_checker/` but stateful (persistent claim
history in Postgres) rather than stateless, and not a trade-action framing. Currently in MVP
build-out.

**Always read `analyst-audit/CLAUDE.md` first** — it's the authoritative architecture doc (the
three-stage pipeline, claim schema, MVP scope, onboarding-flow rationale) and is kept current.
`analyst-audit/TASKS.md` is the working build-out backlog, not architecture reference — see
"Task files and completion records" below before reading or updating it.

## Task files and completion records

A project directory may have a `TASKS.md`/`tasks.md`: a working backlog for Codex, separate
from that project's `CLAUDE.md`, which stays architecture-only.

### Adding a task (Claude's job)

Append one line, flat list, no grouping or narrative: `- [ ] [tag] <task description> —
Requested: YYYY-MM-DD HH:MM TZ`. No need to read the rest of the file first, the point of this
format is that appending doesn't require loading prior context. `tag` is a short lowercase word
for the relevant area of the project; check the "Tags in use" line near the top of that
project's task file (add a new tag there if none fit). Get the timestamp from the shell
(`date "+%Y-%m-%d %H:%M %Z"`) rather than guessing it.

### Reading a completed task (Codex's job, documented for reference)

Codex works through these under the division of labor in `AGENTS.md`, and marks a task complete
only after verifying its acceptance criteria, never on a code change alone. A completed entry
stays in the file (its checkbox flips to `[x]`, or an indented `Completed:` line is added for
other layouts) and carries a completion record: local time with timezone, the Codex session ID,
and a commit SHA if the work was committed, preserving the `Requested:` field and tag Claude
added rather than overwriting them. Once a task file has a lot of completed entries, the older
ones get moved to a `TASKS_ARCHIVE.md` in the same directory. See `AGENTS.md`'s "Task files and
completion records" and "Archiving completed tasks" sections for the exact format and an
example, that's the file Codex actually reads, so it's the source of truth for this part.
