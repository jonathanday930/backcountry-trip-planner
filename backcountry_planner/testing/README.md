# Accuracy validation process

How to check our routing/elevation engine against Komoot's public route
planner for a park, end to end. This is the runbook to hand back to Claude
in a future conversation — point it at a park and this file, and it can
rebuild the whole comparison without re-deriving the process from scratch.

Not wired into `npm test` in either package — run by hand after touching
`elevation.ts` or `graph.ts` in a way that could shift distances or
gain/loss, or when validating a newly-added park.

## The workflow, step by step

**1. Find real, published routes for the park.**
Don't invent stop sequences — search for actual guide/trip-report sources
(Backpacker, AllTrails, NPS trail-mileage PDFs, wilderness-permit guides)
for the park's well-known multi-day itineraries. Cross-check every stop
name against the park's real `backend/data/<dataDir>/campsites.json` so
every id used below actually exists in the app — a route is only useful
for testing if the app can resolve every stop.

**2. Pull lat/lon for each stop** from that same `campsites.json` (or
`trails.geojson`/`roads.geojson` for a raw trailhead not in the campsite
list).

**3. Add the route(s) to `test-routes.json`**, one object per route:
```json
{
  "park": "<park id from backend/src/parks.ts>",
  "name": "Route name",
  "description": "N days / N nights, out-and-back|point-to-point|loop",
  "stops": [
    { "role": "start", "id": "...", "name": "...", "lat": 0, "lon": 0 },
    { "role": "stop-1", "id": "...", "name": "...", "lat": 0, "lon": 0 },
    { "role": "end", "id": "...", "name": "...", "lat": 0, "lon": 0 }
  ]
}
```
Mirror it as a readable leg table in `test-routes.md` (optional, for
humans skimming the doc — not read by any script).

**4. Scrape Komoot for every leg:**
```
node testing/komoot-lookup.mjs [park id]
```
Drives Komoot's planner (`komoot.com/plan`) via Playwright — no public API
exists for this, so this is the only automatable path. Writes
`testing/komoot-results.json`. Takes a while (~15-30s per leg: full page
reload + jittered delays + poll-for-stable-stats, plus an internal 3-attempt
retry if the stat panel never stabilizes); a batch of ~17 legs runs long
enough to want `run_in_background`. Pass a park id to scope the run to just
that park's routes — **do this whenever you're touching more than one
park's routes and see "Never run two scrapes at once" below, it's not
optional.**

**5. Get our own engine's numbers for the same legs.** Start the backend
dev server (`cd backend && npm run dev`) and confirm it's actually ready
before querying — first boot loads every registered park's graph plus DEM
rasters, and on a cold start with all ~12 parks this has taken **several
minutes**, not the 30-60s you'd guess from a smaller number of parks. Don't
assume a fixed wait is enough: poll `curl -s -o /dev/null -w '%{http_code}'
http://localhost:3001/api/parks` until it returns `200`, or tail the dev
server's own stdout/log for the `[server] listening on http://localhost:3001`
line (each park logs its own `[graph] <park>: N nodes, N edges...` line as
it loads, which is the fastest way to tell "still working" from "actually
stuck" if it's taking a while). Then:
```
node testing/fetch-ours.mjs [park id]
```
Writes `testing/ours-results.json` by calling our own `/api/route` per
leg. Same park-id scoping as step 4.

**6. Merge into a report:**
```
node testing/build-report.mjs
```
Writes `testing/comparison-report.md` — one table per route, Komoot vs
ours, with a %-off column for distance and for gain/loss.

**7. Get pass/fail totals:**
```
node testing/summarize-report.mjs
```
Prints total/failed/clean counts and lists every leg with an issue,
applying the same noise floors described in "Reading the results" below
(a leg's distance is only scored if Komoot's own distance is ≥0.3mi, and
gain/loss are only scored independently if Komoot's own value for that
direction is ≥50m/164ft). This reads `komoot-results.json` +
`ours-results.json` directly (not the markdown report), so it can't drift
out of sync with `build-report.mjs`'s numbers — always use this instead of
writing an ad hoc one-off script to count passes, and don't hand-edit its
noise floors without updating this doc to match.

**If you edited `test-routes.json` (added/removed/renamed a route or a
leg), clean out now-stale entries before re-scraping:**
```
node -e "
const fs = require('fs');
const routes = JSON.parse(fs.readFileSync('test-routes.json')).routes;
const valid = new Set(routes.map(r => r.park + '|' + r.name));
for (const f of ['komoot-results.json', 'ours-results.json']) {
  const data = JSON.parse(fs.readFileSync(f));
  const kept = data.filter(r => valid.has(r.park + '|' + r.name));
  fs.writeFileSync(f, JSON.stringify(kept, null, 2));
  console.log(f, data.length, '->', kept.length);
}
"
```
Both result files key entries by `(park, name)`; a route you renamed or
whose stop list you changed will otherwise leave a stale, mismatched-length
entry sitting alongside the fresh one after your next scrape only replaces
by exact name match.

## Never run two scrapes at once

`komoot-lookup.mjs` reads the *entire* `komoot-results.json` at startup,
scrapes its assigned routes (which can take many minutes), then merges its
new results into that in-memory copy and writes the whole file back out at
the end. If you run it for two different parks at the same time (e.g. two
`run_in_background` calls, or a fan-out across several agents), each
process's "existing" snapshot goes stale the moment the *other* process
writes — whichever one finishes last overwrites the file with its own
stale copy, **silently deleting** whatever the other process had just
scraped, with no error or warning. This happened repeatedly in practice
and the missing data wasn't discovered until a much later re-run, costing
far more time than running scrapes one at a time ever would have.

**Always run `komoot-lookup.mjs` for one park, wait for it to fully exit,
then run it for the next park.** The same hazard applies to
`fetch-ours.mjs` against `ours-results.json`, though it's lower-risk since
that script runs fast enough that overlap is unlikely by accident — still
don't parallelize it either.

## Reading the results

- **Distance agreement is usually tight** (0-5% off) wherever our engine
  finds a route. Treat anything beyond that as worth a closer look.
- **Gain/loss % swings on legs with small absolute values are noise, not
  signal.** A leg where both sides report under ~100 ft can show a
  100%+ delta from a ~30 ft difference — that's not a real accuracy
  problem, just percentages behaving badly near zero. Only chase gain/loss
  deltas on legs with real elevation change (a few hundred+ feet).
- **A `404 No route found` from our own `/api/route` on a real, walkable
  leg is a genuine network gap**, not a units/accuracy issue — see
  "Diagnosing a routing gap" below.
- **Don't assume Komoot is ground truth if a number looks physically
  implausible** (e.g. near-zero gain on a leg that obviously climbs a
  few thousand feet) — that's much more likely a scraper bug than a
  Komoot data problem. Verify manually in Komoot's own UI before trusting
  a big discrepancy either direction.

## Diagnosing a routing gap

When a leg 404s, or its distance is way off from Komoot while other legs in
the same park are fine (the tell that it's a *routing* problem, not an
elevation-filter one — see "Tuning the elevation filter" below for that
case), don't just add a connector blind. Use
`backend/src/scripts/diagnoseRoutingGap.ts`:

```
cd backend
npx tsx src/scripts/diagnoseRoutingGap.ts --park <parkId> --from <stopId> --to <stopId>
```

This reports: whether the two stops are in the same connected component at
all; the actual path length vs. straight-line distance (a ratio over
~3-4x on a real maintained trail usually means a genuine gap — but check
terrain first, some real trails legitimately switchback that much); and the
nearest non-adjacent node to each endpoint within a radius (default 700m),
which is the fastest way to spot a small, real digitization gap.

**A nearby node is not automatically the fix — verify it before adding a
connector.** Pass `--verify-connector <nodeIdA> <nodeIdB>` to patch a
synthetic edge into an in-memory copy of the graph and re-check
`shortestPath`; only trust a candidate if the tool reports the connector was
actually *used* and the resulting distance is now sane. This session hit
three cases (Mono Creek/Bear Ridge and other legs in sierra-national-forest,
West Fork White River/Lake Eleanor Camp in mount-rainier) where the nearest
non-adjacent node was itself an isolated dead-end fragment — connecting to
it changed nothing, because that fragment didn't lead anywhere closer
either. When `--verify-connector` doesn't help, the real answer is usually
one of: the corridor is genuinely off-network (no maintained trail exists —
confirm with a web search for the trail name before concluding this), or
the digitization gap is deeper than one connector can close (multiple
disconnected fragments, not a simple missing link). Either way that's a
"restructure or remove this test leg" case (see below), not a
`MANUAL_CONNECTORS` one.

If the gap genuinely is small (tens to a couple hundred meters — a
trailhead-parking spur, a river crossing, etc. not contiguously digitized
in OSM) and `--verify-connector` confirms it closes the gap to a sane
distance, add it to `MANUAL_CONNECTORS` in `backend/src/graph.ts` following
the existing entries' pattern, then re-run steps 5 and 6 above to confirm
through the real `/api/route` path.

### When the gap is too big for a straight `MANUAL_CONNECTORS` edge

`MANUAL_CONNECTORS` is a straight line between two points (`[LonLat,
LonLat]`) — fine for a real digitization gap under ~200m, but a real trail
that's missing over a longer distance (a whole unmapped spur, e.g. a
campsite that's an isolated island in its own connected component with
nothing at all nearby, not just a small break in an otherwise-continuous
line) needs its actual curved geometry, not a chord across the terrain. A
straight connector over any real distance will cut across contours instead
of following the trail's actual grade — on steep terrain (canyon walls,
switchbacked descents) this produces a physically-impossible "cliff" leg
(all the elevation change crammed into a short straight segment) that's
just as wrong as leaving the gap unfixed, just wrong in a way that's easy
to miss until someone checks the terrain.

If the park has a georeferenced overlay (`ZONE_MAP_OVERLAYS` in
`PlannerPage.tsx` — see `backend/scripts/README.md` step 5/7) and it shows
a real trail through the gap, trace it and add it as an actual
`trails.geojson` `LineString` feature (`kind` gets set automatically by
`parkNetwork.ts`, don't set it in the source file) instead of a
`MANUAL_CONNECTORS` entry:

1. **Find the correspondence anchors first, not the shape.** Get the exact
   coordinate the gap should start and end at — the isolated stub's own
   endpoint (from its existing `trails.geojson` feature) and the nearest
   vertex of whatever trail it should connect to (search every feature's
   every vertex within a few hundred meters, don't assume the nearest
   feature by name is the right one). Use these **exact** coordinates
   (matching to 6 decimal places) as your new feature's first/last points —
   `buildGraph`'s `getOrCreateRawNode` dedupes on exact coordinate match
   regardless of whether the shared point is an endpoint or an interior
   vertex of the other feature, so this alone gets you auto-merged into the
   graph with no `MANUAL_CONNECTORS` entry needed.
2. **Trace the interior shape from pixels, don't eyeball waypoints.**
   Reading grid coordinates off a zoomed screenshot and picking "plausible"
   intermediate points is guessing with extra steps — it produces a path
   that looks fine at a glance but doesn't correspond to anything on the
   actual map, and won't reliably reflect the real trail's terrain-following
   shape. Instead, threshold the scan's dashed-line pixels (same
   near-black connected-component technique as pictogram detection in
   `backend/scripts/README.md` step 4) in a tight crop around the gap, then
   chain the resulting dash-blob centroids top-to-bottom (or
   nearest-neighbor from a known start point) into an ordered polyline.
   **Watch for other trails crossing the same crop** — plot your park's
   *existing* `trails.geojson` features (excluding the one you're about to
   add — plotting your own not-yet-committed edit back onto the same image
   defeats the whole check) over the scan first, in a distinct color, so
   you can see which dashed pixels are already covered by real data versus
   which ones are the actual gap, before tracing anything.
3. **Verify the result, don't just trust that it looks reasonable.**
   Cross-check the new leg's total distance against any independently
   published mileage (permit trail-description text in `permits-raw.json`
   is a good source — NPS/USFS pages often state inter-camp distances
   directly), and sanity-check the elevation profile by sampling
   `getDemElevationMeters` (`backend/src/demElevation.ts`) along your
   traced points: a real trail's grade is rarely more than ~15-20% sustained
   for any stretch — a big elevation jump packed into one short leg is the
   signature of a guessed/interpolated point standing in for real trail
   geometry, not an actual traced switchback.
4. Restart the backend (data-file changes need a manual `tsx watch`
   trigger — see "Dev-server process gotcha" in `backend/scripts/README.md`)
   and confirm the `/api/route` leg now resolves with a sane distance and
   elevation profile before considering it done.

## Tuning the elevation filter for a park (gain/loss consistently off)

If distance is close (0-5%) but gain/loss is consistently 20%+ off across
several legs in one park, don't assume it's a routing bug — it's more
likely `elevation.ts`'s noise filter needs a per-park tune. Real finding
from doing this for Grand Canyon and Yellowstone (both needed it; Rocky
Mountain didn't):

- **Pure threshold-tuning has a hard ceiling on rugged terrain.** A single
  `NOISE_THRESHOLD_METERS` sweep can't get both gain and loss within 10% at
  once on some legs — a real bump's size determines, all-or-nothing,
  whether crossing the threshold treats it as a feature or discards it as
  noise, so gain wants one threshold value and loss wants a different,
  non-overlapping one, with nothing in between hitting both.
- **A moving-average smoothing pass before the hysteresis filter breaks
  that all-or-nothing jump.** `elevation.ts`'s `movingAverage()` (a
  symmetric box filter, `windowRadius` samples each side) turns a hard
  jump into a gradual one, so the threshold sweep can actually land near
  Komoot's numbers instead of skipping past them.
- **The right (smoothWindow, threshold) pair is genuinely per-park, not
  universal.** Grand Canyon's exposed rock switchback terrain wanted
  `window=7, threshold=9`; Yellowstone's corridor terrain wanted `window=4,
  threshold=3` — mixing them and picking one global config made Yellowstone
  visibly worse while barely helping Grand Canyon. `PARK_FILTER_CONFIG` in
  `elevation.ts` is keyed by `dataDir` for exactly this reason. A park not
  in that table falls back to the original unsmoothed 25m-threshold
  behavior — don't add a park to it without actually running the sweep
  below against real Komoot data first.
- **Exclude tiny-value legs when picking a threshold.** A leg where
  Komoot's own gain or loss is under ~50m makes %-off meaningless noise (a
  10m difference on a 10m base reads as "100%") and will visibly corrupt
  which config looks "best" if you let it into the scoring average.
- **A missing-trail-segment fix (see above) and a filter re-tune can
  target the same leg for different reasons.** Grand Canyon's Monument
  Creek → Hermit Creek leg needed both: the missing connector fixed its
  *distance* (5.5% off → 0.3% off) but barely moved gain/loss on its own;
  the filter re-tune is what closed most of the remaining gain/loss gap.
  Don't assume one fix explains everything just because it measurably
  helped.

To re-run this sweep, use `backend/src/scripts/sweepElevationFilter.ts`
(run from `backend/`, and make sure `testing/komoot-results.json` already
has Komoot data for the park — run `komoot-lookup.mjs` first if not):

```
npx tsx src/scripts/sweepElevationFilter.ts --park <parkId>
```

It grid-searches `smoothWindow` (0-12) × `threshold` (1-40m) against every
already-scraped Komoot leg for that park (not just the failing ones, so a
fix for one leg can't silently regress another), scoring only legs where
Komoot's own gain or loss is ≥50m, and prints the best config plus a
per-leg detail table flagging anything that still qualifies as an issue
(>10% off *and* >125ft off) even at that best config — that's your signal
to reach for a corridor override instead (next section).

Once you've found a park's config, add it to `PARK_FILTER_CONFIG` in
`backend/src/elevation.ts`, restart the backend, and re-run steps 5-6 above
to confirm through the real `/api/route` path (not just the sweep script's
approximation — this session hit at least one leg where the sweep's raw
DEM-sampling and the live server's cached edge-profile logic gave slightly
different numbers near a threshold boundary, close enough that it didn't
change which config to pick, but not identical).

## Per-corridor filter overrides (when one park config can't fit everything)

Sometimes a park's rugged terrain isn't uniform enough for a single
`PARK_FILTER_CONFIG` entry to work everywhere: an exhaustive sweep across
the whole park finds a config that fixes some legs while regressing others,
with no single value that satisfies both — a real ceiling of the per-park
architecture, not a search that didn't try hard enough. Confirmed this
session for Grand Canyon Full's North Kaibab corridor, Zion's Narrows and
Kolob Arch, Yellowstone's Pelican Valley, North Cascades' Big Beaver Creek,
and Sierra National Forest's French Trail — each needed its own tuning
independent of the rest of its park.

`CORRIDOR_FILTER_CONFIG` in `backend/src/elevation.ts` handles this: a
named override, keyed by `dataDir`, that gives one specific real stretch of
trail its own `(smoothWindow, noiseThresholdMeters)`. It's a **geographic
bounding box**, not a list of stop ids — a leg is matched by how much of
its own edges fall inside the box (`minCoverage`), so the override applies
to anyone routing through that corridor, not just this test suite's exact
stops. This also means it generalizes to a live user clicking two nearby
points along the same trail, which a stop-id-keyed override wouldn't.

**Workflow:**

1. Find the specific leg's own best config and a tight bbox for its real
   path:
   ```
   npx tsx src/scripts/sweepElevationFilter.ts --park <parkId> --route "<route name>" --leg <0-based index>
   ```
   This prints the tight bbox (the leg's own edge extent, padded by
   `--pad`, default 0.01°≈1.1km), the best `(window, threshold)` for that
   leg alone, and — critically — a **leakage check**: how much that bbox
   overlaps every *other* leg in the park. Read this before writing
   anything to `elevation.ts`.

2. **If nothing leaks above ~15%,** the bbox is safe as-is. Add it to
   `CORRIDOR_FILTER_CONFIG` with `minCoverage` around 0.5 (leaves headroom
   for edge-snapping jitter without being so loose it catches unrelated
   legs).

3. **If something leaks,** don't ignore it just because the coverage
   number is under your planned `minCoverage` — verify what that leg's
   *current* numbers are (is it already passing under the park default?)
   before assuming the override won't touch it. Two failure modes found
   this session:
   - **A short leg is a geographic subset of a longer one** (e.g. a
     route that stops partway along the same trail as your target leg —
     Grand Canyon's "North Kaibab Trailhead → Cottonwood Campground" is a
     16km prefix of the 28km "→ Bright Angel Campground" leg). A bbox
     can't separate two legs where one fully contains the other's
     geography — even a 100%-covered short leg needs to be excluded some
     other way. Use the `minPathMeters` field (added specifically for
     this) to require a minimum total path length before the override
     applies, picking a threshold between the two legs' real distances.
   - **Two adjacent legs are similarly small and close together** (Inyo's
     "Cottonwood Lakes → Cottonwood Pass" and "Cottonwood Pass → Trail
     Pass" are both ~2.9km with nearly identical bounding boxes). If
     `minPathMeters` can't separate them either (similar lengths) and the
     regressed leg was already fine, weigh the trade honestly: is fixing
     the flagged leg worth breaking a clean one? If the flagged leg is
     only marginally over the qualifying bar, it often isn't — restructure
     that one leg out of the test route instead (see below) rather than
     force a corridor override that costs more than it gains.

4. **If the leg's own best-achievable error is still large (rule of thumb:
   >30%) even in isolation,** don't force a corridor override — the tool
   prints a warning at this threshold. Sanity-check with the raw
   (unfiltered) signal: a `window=0, threshold=0` sweep result close to
   Komoot's number means real noise exists to filter out (keep tuning); a
   raw signal *already far below* Komoot's number means filtering — which
   can only remove elevation change, never add it — can't get you there.
   That's a **DEM/trail-digitization-resolution ceiling** (found for
   Sequoia-Kings Canyon's Lakes Trail: raw loss was 44% under Komoot's
   number even completely unfiltered). If distance is also off from
   Komoot on top of that, it's more likely a **path-choice divergence**
   instead (found for Zion's Southwest Desert wash-walking leg: 23% off on
   distance, 57% ceiling on elevation even at the sweep's best config).
   Neither is filter-tunable — restructure or remove the leg (below).

5. After editing `CORRIDOR_FILTER_CONFIG`, restart the backend and re-run
   steps 5-6 from the top workflow **for every park that has any corridor
   override**, not just the one you just edited — a bbox fix in one park
   doesn't affect others, but always re-verify the specific park you
   touched, including legs far from the corridor you just added, since a
   transcribed-wrong bbox (a copy-paste padding error, confirmed to happen
   in practice this session) can silently widen scope and catch legs you
   didn't intend to touch.

## When a leg won't come within 10% no matter what (route restructuring)

If a specific leg resists both the routing-gap fix and the filter re-tune
above, the underlying trail corridor may simply be a case where Komoot's
and our engine's elevation modeling diverge — not fixable by tuning at all.
Before accepting that, it's worth trying to change *which* leg is being
tested, but the two ways of doing this have very different odds:

- **Reusing a sub-segment already proven clean elsewhere reliably works.**
  If another route (or another leg of the same route) already shows a
  particular point-to-point segment scoring well, restructuring a failing
  route to go through that same segment instead of the problem one — e.g.
  dropping an intermediate stop and routing directly to the next one, or
  swapping which nearby trailhead/campsite a route starts from — has a good
  success rate, because you already know that specific stretch of trail
  behaves.
- **Swapping in an entirely untested stop or corridor is a coin flip at
  best, and often makes things worse.** Trying a different, previously-
  unused trailhead cluster elsewhere in the park (hoping a "different"
  corridor won't have whatever caused the original mismatch) has about as
  much chance of introducing a *new*, sometimes larger, divergence as
  fixing the old one — this happened multiple times across several parks in
  practice, with replacement legs coming back 40-80% off instead of the
  10-30% they replaced. **Diagnose connectivity first** (see "Diagnosing a
  routing gap" above — a distance ratio of ~1.0-2.0x over hundreds of edges
  is normal winding trail, not a red flag) but understand that a clean
  connectivity ratio says nothing about whether the *elevation profile*
  will match Komoot's; only actually scraping and comparing tells you that.
  **Always keep the original route/stops around (or note them) before
  replacing** so you can revert cleanly if the substitute scores worse —
  don't discard a working baseline while chasing a marginal improvement.
- If a park has a required minimum leg count, restructuring one route to
  drop a leg means finding slack elsewhere (extend a different route by one
  stop) before you can afford to shrink another.
- A leg on a **mandatory single-campsite permit corridor** (the only
  campsite in its zone, with no alternate a hiker could realistically use
  instead) has no substitution option at all — try a per-corridor override
  first (see above; it exists specifically for this). If that also can't
  close it — confirmed via the raw-signal check, a bbox that can't be made
  to exclude an adjacent route, or a genuine path-choice divergence — it's
  a real ceiling, not a research gap, and worth documenting the specific
  reason on the removal rather than silently dropping the leg.

## Gotchas already handled in `komoot-lib.mjs` (don't re-break these)

- **Komoot doesn't always default to "Hiking"** as the route profile —
  `selectHikingSport()` explicitly clicks "Select a sport" → "Hiking"
  rather than relying on a default that sometimes doesn't apply.
- **Komoot renders thousands with a comma** (`"1,550"`). `parseFloat`
  alone stops at the comma and silently returns `1`. Strip commas before
  parsing.
- **Komoot animates its stat numbers counting up** after a route
  (re)computes. A fixed wait can catch a long/high-relief route mid-count
  and record a fraction of the real value. `waitForStableStats()` polls
  every 500ms and only accepts a reading once two consecutive reads agree,
  rather than trusting a single read after a fixed delay.
- **Small randomized delays (200-900ms) between actions** throughout — not
  for evasion, just to avoid hammering a live site harder than a human
  clicking through it would.

## File manifest

| File | Purpose |
|---|---|
| `test-routes.json` / `test-routes.md` | The route itineraries under test (source of truth: `.json`, `.md` is just readable) |
| `komoot-lib.mjs` | Shared Playwright logic: dismiss overlays, select sport, set a waypoint, parse stats, poll for stability |
| `komoot-lookup.mjs [park id]` | Runs `komoot-lib.mjs` over every leg in `test-routes.json` (or just one park's) → `komoot-results.json` |
| `fetch-ours.mjs [park id]` | Hits our own `/api/route` for every leg (or just one park's) → `ours-results.json` |
| `build-report.mjs` | Merges both results files → `comparison-report.md` |
| `summarize-report.mjs` | Reads the same two results files → prints pass/fail totals and lists every leg with an issue |
| `komoot-results.json` / `ours-results.json` | Raw per-leg data from each source |
| `comparison-report.md` | The actual comparison table, regenerated by `build-report.mjs` |
| `../backend/src/scripts/sweepElevationFilter.ts` | Grid-searches `(smoothWindow, threshold)` for a park's `PARK_FILTER_CONFIG`, or a single leg's `CORRIDOR_FILTER_CONFIG` bbox + config (see "Tuning the elevation filter" / "Per-corridor filter overrides" above) |
| `../backend/src/scripts/diagnoseRoutingGap.ts` | Checks connectivity/path-length ratio between two stops and finds nearby unconnected trail fragments; verifies a candidate `MANUAL_CONNECTORS` fix before you commit it (see "Diagnosing a routing gap" above) |

This whole directory is untracked by git with its own `package.json`
(Playwright only), separate from `backend`/`frontend`. The two scripts
above are the exception — they live in `backend/src/scripts/` since they
import backend's TypeScript modules directly and run via backend's own
`tsx`, but they're part of this same accuracy-tuning workflow.
