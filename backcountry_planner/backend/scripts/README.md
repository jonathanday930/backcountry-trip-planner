# Backcountry permit data pipeline

How the campsite/trailhead data and trail/road networks in `backend/data/`
were built, so a new park can be brought in later without re-deriving all of
this from scratch. Everything here is read from public Recreation.gov and
OpenStreetMap endpoints — no scraping tool avoids their rate limits or ToS,
this just automates clicking through the same pages a human would.

## The source: Recreation.gov's permit API

Every NPS/USFS backcountry permit on Recreation.gov exposes a JSON API that's
more detailed than its own UI:

- `GET https://www.recreation.gov/api/search/geo?q=backcountry%20permits&radius=3000&size=200&fq=entity_type%3Apermit&sort=score&start=0&lat=39.8283&lng=-98.5795`
  — nationwide search, no login needed. `radius=3000` with `lat/lng` at the
  US center effectively removes the geo bias search normally applies.
  Returns `{entity_id, name, entity_type, state_code, ...}` for every permit
  entity matching the query.
- `GET https://www.recreation.gov/api/permitcontent/<entity_id>` — the full
  permit payload, **also no login needed** (confirmed empirically — don't
  assume auth is required just because the web UI shows a login prompt).
  Key fields:
  - `payload.latitude` / `payload.longitude` — the permit's own declared
    location. Used as a sanity anchor (see "Data quality" below).
  - `payload.entrances[]` — named physical access points (trailheads,
    parking areas, boundary crossings, boat launches). Each has
    `latitude`/`longitude`, `name`, `has_parking` (unreliable — see below),
    and `division_ids[]` linking it to the zones/campsites it can reach.
  - `payload.divisions{}` — campsites/zones, keyed by id. Each has
    `latitude`/`longitude` (sometimes 0/absent for diffuse zones), `name`,
    `code`, `district` (the "Starting Area" name — see below), and
    `children[]`/`entry_ids`/`exit_ids` for combo/aggregate divisions.

### "Starting Area" vs "Entry & Exit Points" — don't confuse these

Recreation.gov's own UI has two different granularities that both look like
"starting points" but aren't:

1. **"Select a Starting Area"** (the pills on the Detailed Availability page)
   = the distinct values of `division.district`. This is a coarse zone
   grouping used only to filter the reservation calendar.
2. **"Entry & Exit Points"** (a dropdown deeper in the itinerary builder) =
   `payload.entrances`, individually named trailheads/boundary
   crossings/boat launches. **This is what our `trailhead` records match.**

Confirmed by comparing `division.district` values against the site's own
"Starting Area" pills — they're identical strings (e.g. Yellowstone's
districts are exactly `Blacktail/Hellroaring`, `Gallatin/Northwest`, `Lamar`,
etc.). So: don't reduce the entrance list down to the 13-ish district names
thinking that's "more correct" — the granular entrance list is the right
comparison point, and it's *also* real, sourced data.

## One-time setup: an authenticated session (only needed for `scrape-permit-campsites.ts`)

`permitcontent` doesn't need login, but if you ever do need an authenticated
request (e.g. a page that genuinely gates on login), the pattern is:

```
npx tsx scripts/rec-gov-login.ts            # opens a real Chrome window, log in by hand, press Enter when done
npx tsx scripts/rec-gov-export-storage.ts   # exports cookies to rec-gov-storage-state.json for fast reuse
```

This uses a dedicated Playwright profile (`scripts/rec-gov-profile/`, gitignored)
— never your actual Chrome profile/cookies.

## Bringing in a new park: step by step

### 1. Find the permit ID

If you don't already have it, hit the nationwide search (see above) and grep
the `name`/`entity_id` you want, or if you have the recreation.gov URL
already (`/permits/<id>/registration/...`), the ID is right there.

### 2. Scrape campsites + trailheads

Two scripts do this, pick based on scope:

- **One specific permit**: `npx tsx scripts/scrape-permit-campsites.ts <permitId> <parkSlug>`
  (e.g. `4675336 shenandoah`). Writes `data/<parkSlug>/campsites.json` +
  `permits-raw.json`.
- **Everything nationwide at once**: `npx tsx scripts/scrape-all-backcountry-permits.ts`
  — re-runs the full nationwide search and re-scrapes all ~47 permits found,
  grouping multi-permit parks (Zion has 3 permits, Canyonlands has 4) by
  `payload.recarea_name`. Takes a few minutes; polite 300ms delay between
  requests. **Fully regenerates from scratch each run** (accumulates
  in-memory across the whole run, not merged against stale disk state) —
  safe to re-run after fixing a bug in the classification logic.

Both scripts call the same `deriveCampsiteRecords()` in `scripts/lib/deriveRecords.ts`
for the full entrance/division → record derivation (coordinate validation,
entrance-type filtering, at-large/zone classification), which itself calls
the lower-level helpers in `scripts/lib/enrich.ts` (starting areas, closed
detection). **If you change any of this logic, change it once in one of
these two files — never inline it in either scraper again.** This isn't
hypothetical caution: the at-large/zone classifier, the coordinate-anchor
check, and the Issue Station filter (below) all had to be fixed in two
places the first time because they were duplicated, before being
consolidated into `deriveRecords.ts`.

### 3. Data quality checks already baked in (don't re-discover these)

Recreation.gov's *own* source data has real errors. All of these are handled
automatically by both scrapers now:

- **Out-of-range coordinates**: `|lat| > 90` or `|lon| > 180` — obviously
  broken, easy to catch.
- **Dropped-digit longitude**: e.g. Yellowstone's "Mammoth Terraces" had
  `longitude: -110707906` (missing the decimal point). Passes a naive range
  check but is nowhere near the park.
- **Dropped-digit, still-valid-looking longitude**: three Zion climbing
  camps had `longitude: -12.9494` (should be `-112.9494`) — a perfectly
  valid longitude, just wrong for Utah (mid-Atlantic Ocean). A pure range
  check can't catch this.
- **Sign-flipped coordinates**: Mount Rainier camps with negative latitude
  (Antarctica instead of Washington); Joshua Tree sites with positive
  longitude (China instead of California).

All four are caught by one check: reject any point more than
`MAX_DEGREES_FROM_PERMIT` (3°) from the permit's own declared
`payload.latitude/longitude`. Range check alone only catches the first case.

- **Zone/at-large mislabeling**: a division with real coordinates isn't
  necessarily a single reservable site — Grand Canyon's "At-Large Camping"
  zones and Mount Rainier's "Cross Country Zone"/"Alpine Zone" areas have a
  rough reference point for a *diffuse* area, not a specific site. Detected
  by name pattern (`/at.large/i` or `/\bzone\b/i`), not by "has coordinates."
  Deliberately narrow — "Camp"/"(Group Site)" names (Camp Muir, Carbon River
  Camp) are real single fixed locations that are just legitimately off-trail
  (alpine climbing camps, cross-country zones by nature), not zones.
- **`has_parking` is unreliable**: for Yellowstone it's `false` on every
  single entrance, including obviously-real drivable trailheads. Don't use
  it as a filter signal.
- **`payload.entrances` isn't only trailheads**: entrance `type` also
  includes `"Issue Station"` — a ranger station / permit pickup office, not
  a hiking start point — and it can carry the *exact same name and
  coordinates* as a real trailhead nearby (Rocky Mountain's "Longs Peak" has
  both). Left unfiltered, this either double-plots the same spot or — worse
  — produces two records with an identical `id`, which shows up as a React
  "duplicate key" console warning on that park's map. `deriveCampsiteRecords()`
  excludes `entrance.type === "Issue Station"`; every other type seen so far
  (Trailhead, Parking Area/Lot, Entry Point, Exit Point, Launch Point) is a
  real place you'd start from and stays. If you ever see a duplicate-key
  warning on a park's planner page, check for this before assuming it's a
  new bug.
- **The nationwide search misses real permits.** Rocky Mountain National
  Park's actual wilderness permit (entity_id `4675320`) never appeared in
  `scrape-all-backcountry-permits.ts`'s ~47 results — it just didn't score
  highly enough for the query text used, not a filtering bug on our end. If
  a park you expect is missing from the batch output, search for it
  directly (`q=<park name>` instead of `q=backcountry%20permits`) and use
  `scrape-permit-campsites.ts` with the specific ID you find.
- **"Closed" name patterns**: watch for the false-positive shape
  `(when X Closed)` — e.g. Grand Canyon's "NCG - (when N.Rim Closed) North
  Rim Campground" describes when an *alternate* option becomes available,
  it's not itself closed. `scripts/lib/enrich.ts`'s `isClosed()` excludes
  this shape specifically.
- **No real closure date exists in the source.** `last_updated` is a
  database-touch timestamp (often identical to `date_created`), not a
  closure event date. We stamp `closedAsOf` with *the date we scraped and
  saw it marked closed*, not a fabricated "since" date — that's an honest
  fact we actually know.

If you hit a new corruption pattern scraping another park, add the check to
`scripts/lib/deriveRecords.ts` (or `scripts/lib/enrich.ts` if it's about
starting-areas/closed logic specifically) and re-run `rebuild-from-raw.ts`
to apply the fix retroactively to every already-scraped park — don't just
patch the one park's JSON by hand.

### 4. (Optional) Zone polygon boundaries

Only done for Shenandoah so far. Some parks' "zone" divisions have no
lat/lon at all in the permit API (a name + trail list + entry/exit points,
but no point). If you want a real representative point instead of leaving
it unplottable:

1. Find the park's linked GIS map in `payload.links` (usually an NPS ArcGIS
   "Trip Planning Map" or similar).
2. Use `scripts/rec-gov-inspect.ts <arcgis-url>` to capture the underlying
   ArcGIS `FeatureServer` endpoints (network requests get logged to
   `scripts/rec-gov-debug/api-hits.json`).
3. Query the polygon layer directly:
   `<FeatureServer>/<layerId>/query?where=1=1&outFields=NAME&returnGeometry=true&outSR=4326&f=geojson`
   — public, no auth needed (confirmed for NPS ArcGIS Online layers).
4. Match zone names between the permit data and the GIS layer (expect minor
   spelling mismatches — e.g. Shenandoah's "Weakly" vs the GIS layer's
   "Weakley" — handle via a small hand-written alias map, not fuzzy
   matching, which risks false-positive merges).
5. Compute a guaranteed-inside-polygon point with `@turf/point-on-feature`
   (a naive centroid can land outside a concave polygon).

See `scripts/build-shenandoah-zones.ts` for the full worked example — it's
written to be adapted per-park, not run generically (the alias map and file
paths are Shenandoah-specific).

### 5. (Optional) Scanned zone map overlay — an alternative to zone polygons

Reconstructing a park's zone boundaries as clean `zones.geojson` polygons
(step 4) is only as good as the source GIS layer and the merge logic —
Joshua Tree's generated polygons ended up visibly wrong for several zones.
Rather than keep fighting that, this overlays the park's *own official
scanned zone map* (a PDF/image most parks already publish, e.g. NPS/USFS
"Backcountry Camping Zones" maps) directly on the Leaflet map as a
georeferenced image, toggleable independently of `zones.geojson` shading.
Worked example: Joshua Tree (`frontend/public/zone-overlays/joshua-tree.jpg`,
config in `ZONE_MAP_OVERLAYS` in `frontend/src/PlannerPage.tsx`).

This needs Python (Pillow/numpy/scipy) for the image-processing steps below
— not otherwise part of this repo's toolchain, so use a throwaway venv
rather than polluting the system interpreter:

```bash
python3 -m venv /tmp/georef-venv && source /tmp/georef-venv/bin/activate
pip install pillow numpy scipy
```

**1. Crop the scan down to just the map itself.** Title bars, legends, scale
bars, and inset locator maps aren't georeferenced and will corrupt every
later step if left in — crop them out first (eyeball the crop box via a
quick full-image preview, adjust, repeat):

```python
from PIL import Image
im = Image.open('/path/to/downloaded/zone-map.webp').convert('RGB')
im.crop((left, top, right, bottom)).save('cropped.png')
```

**2. Get ground-truth correspondence points.** Use this park's own
`campsites.json` entries with `"type": "trailhead"` only — these are real
scraped trailhead-board locations, precise enough to be trustworthy ground
truth. **Don't use `"type": "at_large"` zone centroids for this** — they're
frequently rough/wrong estimates, not surveyed points (Joshua Tree's
`north-entrance-zone` had a bare latitude typo, `33.0455` instead of
`34.0455`, that dragged the whole park's map auto-fit/zoom out to include
the Mexican border — worth sanity-checking every zone centroid's lat/lon
range while you're in here regardless of whether you hit this exact bug).

**3. Bootstrap a rough transform by hand.** Crop+zoom the map with a pixel
grid drawn on top (so you can read off coordinates precisely instead of
eyeballing), and hand-pick pixel coordinates for ~4 markers whose label is
unambiguous:

```python
from PIL import Image, ImageDraw
im = Image.open('cropped.png').convert('RGB')
draw = ImageDraw.Draw(im)
for x in range(0, im.width, 50):
    draw.line([(x, 0), (x, im.height)], fill=(255, 0, 0)); draw.text((x + 2, 2), str(x), fill=(255, 0, 0))
for y in range(0, im.height, 50):
    draw.line([(0, y), (im.width, y)], fill=(255, 0, 0)); draw.text((2, y + 2), str(y), fill=(255, 0, 0))
im.save('grid.png')  # crop tighter + re-run at a higher zoom scale for sub-pixel precision
```

Fit an initial per-axis linear regression (`lon = a·px + c`, `lat = e·py + f`,
via `numpy.polyfit`) from those ~4 points. This doesn't need to be accurate
yet — it only exists to bootstrap the auto-matching in the next step.

**4. Auto-detect every marker, then auto-match the rest.** Hand-picking
pixel coordinates one at a time doesn't scale and is error-prone (a marker
sitting near a label isn't necessarily *that* label — the bootstrap fit
below caught a mismatched `boy-scout-trail-keys-west` marker that direct
eyeballing had assigned to the wrong icon). Instead, sample the marker
icon's color from the map's own legend swatch, then find every matching
blob on the full map by color-threshold + connected-component labeling:

```python
import numpy as np
from scipy import ndimage
arr = np.array(Image.open('cropped.png').convert('RGB')).astype(int)
r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
mask = (r < 75) & (g > 95) & (g < 165) & (b > 125) & (b < 195) & (b > r + 55) & (g > r + 35)  # tune per map
labeled, n = ndimage.label(mask)
sizes = ndimage.sum(mask, labeled, range(1, n + 1))
centroids = ndimage.center_of_mass(mask, labeled, range(1, n + 1))
blobs = [(cx, cy) for (cy, cx), s in zip(centroids, sizes) if s >= 15]  # filter noise by min blob size
```

Then, for every `trailhead`-typed campsite, use the bootstrap fit from step
3 to predict its pixel position and match it to the nearest detected blob
(within a tolerance, e.g. ~40px) — this recovered 10 correspondence points
for Joshua Tree from a 4-point bootstrap, all self-consistent because
they're matched by *predicted position*, not by which label happens to sit
closest on the page.

**5. Fit the real transform, and use all 3 corners, not just 2.** Refit
least-squares over every matched point. A pure axis-aligned rectangle (fit
`lon`/`lat` independently per axis, i.e. 2 opposite corners) is the simplest
overlay Leaflet supports natively, but scanned paper maps almost always
carry a small rotation/skew from printing or scanning that a rectangle can't
absorb — fitting a full 6-parameter affine (`lon/lat = a·px + b·py + c`
each, via `numpy.linalg.lstsq`) instead roughly halved Joshua Tree's mean
residual (~134m → ~60m). Project image corners `(0,0)`, `(width,0)`,
`(0,height)` through the fitted affine to get the `topLeft`/`topRight`/
`bottomLeft` lat/lon values the frontend needs next. Expect on the order of
50-100m residual error even after a good affine fit — that's roughly the
ceiling given the source scan's own precision, not a sign something's
wrong.

**6. Render it: `RotatedImageOverlay`, not react-leaflet's `<ImageOverlay>`.**
`<ImageOverlay>` only places an axis-aligned rectangle (2 corners), which
throws away the rotation/skew correction from step 5. `frontend/src/RotatedImageOverlay.ts`
is a small from-scratch Leaflet layer (no new npm dependency) that warps the
image to fit 3 corners via a CSS matrix transform — same technique as the
well-known `Leaflet.ImageOverlay.Rotated` plugin. Save the cropped image
under `frontend/public/zone-overlays/<park-id>.jpg` (served as a static
asset, no backend involvement) and add an entry to `ZONE_MAP_OVERLAYS` in
`frontend/src/PlannerPage.tsx`:

```ts
'<park-id>': {
  url: '/zone-overlays/<park-id>.jpg',
  topLeft: [lat, lon],
  topRight: [lat, lon],
  bottomLeft: [lat, lon],
},
```

It renders via `<ZoneMapOverlayLayer>`, toggled by the "Official zone map
overlay" checkbox (only shown when a park has an entry in
`ZONE_MAP_OVERLAYS`), independently of the generated `zones.geojson`
shading — which is currently hidden behind `SHOW_GENERATED_ZONES = false`
in `PlannerPage.tsx` while the overlay approach is being trusted; flip it
back on to compare both at once, or remove the generated-zone rendering
entirely once you're confident the overlay fully replaces it for a park.

**7. If your correspondence points came from `pdftotext -bbox` text (not
color-blob icon detection), a text label's bounding box is NOT the
correspondence point — detect the pictogram, not the label.** Grand
Canyon's map is an ArcMap export with real text objects, so it was tempting
to skip straight from `pdftotext -bbox`'s per-label pixel coordinates to a
correspondence point. But ArcMap offsets every code label from its actual
campsite pictogram (a black square with a white tent glyph) by some
label-placement-collision-avoidance amount that **varies in direction per
point** — up-left for most of one cluster, straight down for another nearby
one. Fitting the affine directly on label positions bakes that offset in as
noise indistinguishable from real correspondence error (a park-wide 165m
mean / 851m worst residual for Grand Canyon, that *looked* like normal
measurement noise until one point's label happened to be offset in the
opposite direction from its neighbors and got misdiagnosed as an outlier
overweighting the fit). The fix: still use `pdftotext -bbox` to cheaply find
*which* labels exist and roughly *where* to look, but then detect the
pictogram itself near each label — same color-blob + connected-component
technique as step 4 above (the tent icon is a small, uniformly-sized near-
black blob with a consistent fill ratio from the white cutout, easy to
threshold and very distinct from thin label-text strokes or dashed trail
lines) — and fit the affine on *those* centroids. For Grand Canyon this
dropped the mean residual to 81m (worst 193m). See the correspondence-point
comment on `grand-canyon-full` in `ZONE_MAP_OVERLAYS`
(`frontend/src/PlannerPage.tsx`) for the numbers.

### 6. Build the OSM trail/road network

```
npx tsx scripts/build-park-network.ts <parkSlug> [padDegrees]
```

Computes a bounding box from the park's `campsites.json` (padded 0.05° by
default), queries Overpass for `highway` ways in that box, and splits them
into `trails.geojson` (path/footway/bridleway/steps/cycleway) and
`roads.geojson` (track/unclassified/tertiary/secondary/primary —
deliberately excludes residential/service/trunk/motorway, see below).

Gotchas:

- **Overpass endpoint flakiness**: the main `overpass-api.de` can 406/504 on
  Node's `fetch` (undici) even when plain `curl` against a mirror works
  fine — the script shells out to `curl` against `lz4.overpass-api.de`
  rather than fighting undici's headers. If you get a 504 "server too busy,"
  it's usually transient — just retry after ~15s, don't treat it as broken.
- **Road-tag filter tuning**: the full highway tag set
  (residential/service/trunk/motorway included) pulls in massive irrelevant
  noise for parks whose campsites are geographically dispersed across a
  wide area — Joshua Tree's bbox reached Palm Springs' entire street grid
  and I-10 ("Sonny Bono Memorial Freeway"), 47k road features down to 11k
  after narrowing the tag set. This is a **bbox-size problem more than a
  tag problem** for parks spanning huge areas (Grand Canyon's full permit
  system, North Cascades) — expect visual clutter there regardless; it
  doesn't break routing, just isn't pretty.
- **`track`/`unclassified` density in real National Forest land is
  expected**, not a bug — Inyo/Sierra National Forest are dense with
  legitimate fire/logging roads. Don't over-filter trying to "clean up" a
  park that's genuinely just full of dirt roads.

### 7. Fetch the park's boundary (for road map styling)

```
npx tsx scripts/fetch-park-boundary.ts <parkDataDir> "<Nominatim search query>"
```

The bbox-size problem noted above (step 6) means a dispersed park's
`roads.geojson` legitimately contains roads that are miles outside the park
proper — Joshua Tree's included Palm Springs' entire street grid. Rather than
trying to filter those out of the data (they're needed for routing — a real
access road can start well outside the boundary), this fetches the park's own
outer boundary polygon so the frontend can style those roads differently
without excluding them.

Uses OSM's Nominatim search API (`polygon_geojson=1`), not Overpass — it
returns an already-assembled Polygon/MultiPolygon straight off the OSM
relation, so there's no ring-assembly step to get wrong. Pass the park's
official name as the query (e.g. `"Joshua Tree National Park"`); the script
prints which OSM relation it matched so you can sanity-check it picked the
right one. If a park's area spans multiple adjacent OSM relations (e.g.
Sequoia and Kings Canyon are two separate relations under one `dataDir` in
this app), run the script once per name and merge the resulting
`boundary.geojson` files' `features` arrays by hand.

This step is optional — a park missing `boundary.geojson` just renders every
road as if it were inside the park (today's default look), so skipping it
doesn't break anything. But it's cheap and fixes real visual clutter, so do
it for every new dispersed/multi-town park.

### 8. Register the park

Add an entry to `backend/src/parks.ts`:

```ts
{
  id: 'some-short-slug',       // used in the URL /park/:parkId
  name: 'Display Name',
  dataDir: 'the-scraped-folder-name-in-data/',  // NOT necessarily same as id
  center: [lat, lon],          // printed by build-park-network.ts as "Suggested center"
  npsParkCode: 'abcd',         // only for actual National Park Service units — see below
}
```

Keep `id` short and distinct from any manually-curated dataDir (e.g. the
hand-built `grand-canyon` vs the full-system scrape's
`grand-canyon-national-park-backcountry-permits` dataDir/`grand-canyon-full`
id) — auto-generated slugs from full park names naturally avoid collision.

If the new park is an actual National Park Service unit (not a national
forest, BLM land, wildlife refuge, etc.), also set `npsParkCode` — the
4-letter code from its nps.gov URL (e.g. `nps.gov/glac` → `'glac'`). This is
what turns on, for free, both the chat agent's official-alerts-backed
`get_trail_closures` tool (`backend/src/tools/closures.ts`) and the map's
clickable hazard/closure pin layer (`backend/src/hazards.ts`) — see
`CLAUDE.md`'s "Map hazard layer" section for how those work. Leaving it
unset just means the park falls back to the old page-scrape behavior for
chat closures and gets no hazard pins — not an error, so it's safe to skip
if you're not sure of the code yet and add it later.

### 9. Verify — don't skip this

Restart the backend (`npm run dev` in `backend/`) and check the startup log
for `[graph] <id>: N nodes, M edges, K campsites snapped, R road segments`.
No crash ≠ correct — always also run:

```
npx tsx scripts/check-snap-distances.ts <dataDir>
```

This reports how far each campsite is from the nearest trail/road edge.
`buildGraph`'s snapping has **no distance cutoff** — it always snaps to the
globally nearest edge, however far, so sparse OSM coverage silently produces
a nonsense multi-km "spur" instead of failing loudly. Cross-reference the
worst offenders' *names*: "(Boat)"/marina names are legitimately
lake-access-only (can't be fixed, just expected); "Cross Country
Zone"/"Alpine Zone"/"At-Large" names are legitimately off-trail by nature
(same category as Rocky Mountain's real curated "Little Rock Lake" at
2792m — a useful sanity baseline for what's "normal" vs a red flag).

Then:

```
npx tsx scripts/verify-park-screenshot.ts <parkId>   # needs frontend dev server running too
```

And a real route test — pick two *nearby* points (not opposite ends of a
huge park; elevation lookups are ~1-2s per 50m sample, so a genuinely long
route can look "hung" when it's just slow on a cold cache):

```
curl "http://localhost:3001/api/route?park=<parkId>&stops=<id1>|<id2>"
```

### 10. Applying a logic fix to already-scraped parks

Every field (`startingAreas`, `closed`/`closedAsOf`, the Issue Station
filter, coordinate validation, at-large classification) is computed by
`deriveCampsiteRecords()` at scrape time — new parks get it automatically.
For parks that were already scraped before you fix or add something to that
function, regenerate them from their cached `permits-raw.json` — **no
network calls, no re-scraping**:

```
npx tsx scripts/rebuild-from-raw.ts
```

This fully regenerates `campsites.json` for every park (a real re-derivation
from raw data, not a field-by-field patch), merging multi-permit parks the
same way the batch scraper does. Safe to re-run any time you touch
`deriveRecords.ts`/`enrich.ts`.

**Shenandoah is excluded** — its `campsites.json` depends on the null-coord
zone placeholders plus the separate zone-polygon fill-in step (`build-shenandoah-zones.ts`,
see step 4). Regenerate it manually instead:

```
npx tsx scripts/scrape-permit-campsites.ts 4675336 shenandoah
npx tsx scripts/build-shenandoah-zones.ts
```

A record *count dropping* after a rebuild isn't necessarily a regression —
e.g. rebuilding after the Issue Station fix dropped Mount Rainier from 245 to
233 records (13 issue stations correctly removed) and a separate permit,
"Mount Margaret Backcountry," from 8 to 0 (all 8 of its camps turned out to
share the same sign-flipped coordinates found earlier under Mount Rainier —
correctly rejecting all of them is the coordinate-anchor check working, not
a new bug). Always check *why* a count changed before assuming something
broke.

### 11. Fetch elevation data — don't skip this either

A newly registered park has no local elevation raster yet and will silently
fall back to slow live queries until you fetch one. See "Elevation data
(local DEM)" below for the full details (fetch script, the flakiness it
works around, and a real corruption bug you must scan for) — in short:

```
npx tsx src/scripts/fetchDem.ts <parkId>
npx tsx src/scripts/scanDemCorruption.ts
```

### 12. Validate accuracy against a real source, and tune elevation filtering if needed

Steps 1-11 get a park's data in and routable, but "no crash" and "distances
look plausible" aren't the same as "matches reality" — the only way to know
is to check against an independent source. There's no public routing API for
backcountry trails specifically, so this compares against Komoot's route
planner (driven via Playwright, since it has no public API) for a handful of
real, published routes in the new park. Full detail, gotchas, and the actual
scripts are in `testing/README.md` — this is the shape of it:

1. **Find real routes, don't invent them.** Search for the park's actual
   published multi-day itineraries (trip-report sites, Backpacker/AllTrails,
   NPS trail-mileage PDFs, wilderness-permit guides) and cross-check every
   stop name against the new park's own `campsites.json` — a route is only
   useful for testing if every stop id actually resolves in our data.
2. **Add the route(s) to `testing/test-routes.json`** — park id, stop
   sequence, each stop's real lat/lon pulled from `campsites.json`.
3. **Scrape Komoot for every leg:** `node testing/komoot-lookup.mjs
   <parkId>` — writes/merges into `testing/komoot-results.json`. Slow (~15-30s/leg,
   full page reload + jittered delays each time); background it for more
   than a couple of legs.
4. **Get our own engine's numbers for the same legs:** start the backend dev
   server (first boot loads every registered park's graph — wait for it to
   actually finish), then `node testing/fetch-ours.mjs <parkId>` — writes/merges
   into `testing/ours-results.json`.
5. **Merge into a report:** `node testing/build-report.mjs` — writes
   `testing/comparison-report.md`, one table per route with a %-off column
   for distance and for gain/loss.
6. **Read the results with the caveats `testing/README.md` documents** —
   %-off on legs where Komoot's own value is under ~50m/100ft is noise, not
   signal; a `404 No route found` on a real leg is a network gap (see
   "Diagnosing a routing gap"), not an accuracy problem; don't trust a big
   discrepancy against Komoot without spot-checking it manually first (its
   own numbers can be wrong, e.g. via a scraper bug — verify before assuming
   our engine is at fault).

Then, based on what the report shows:

- **Distance is usually already close** (0-5% off) if the OSM network is
  complete — if it's not, that's a data-completeness gap (see
  `testing/README.md`'s "Diagnosing a routing gap"), not an elevation issue.
- **If gain/loss is consistently 20%+ off across several routes while
  distance is fine, the park needs its own elevation-filter tuning** — add
  an entry to `PARK_FILTER_CONFIG` in `elevation.ts` following
  `testing/README.md`'s "Tuning the elevation filter for a park" section,
  which documents the actual sweep methodology (grid-searching a smoothing
  window × hysteresis threshold against real Komoot numbers, not guessing,
  via `backend/src/scripts/sweepElevationFilter.ts`). Grand Canyon and
  Yellowstone both needed this; Rocky Mountain didn't — don't assume every
  park will.
- **If one specific corridor still won't come within range even after a
  park-wide tune** (a real ceiling — some parks have terrain rugged enough
  that no single park-wide config fits every trail), see
  `testing/README.md`'s "Per-corridor filter overrides" section —
  `CORRIDOR_FILTER_CONFIG` lets one specific stretch of trail (a geographic
  bounding box, not a stop-id list) override the park default.
- A park not added to `PARK_FILTER_CONFIG` keeps the original default
  (unsmoothed, 25m threshold) — safe, but only validated against Komoot for
  the parks actually swept, so check before assuming a new park's numbers
  are trustworthy.

## Elevation data (local DEM) — do this for every new park

Route distance/gain/loss doesn't come from a live API at request time — it's
served from a local elevation raster downloaded once per park. **A newly
registered park has no elevation data until you run this.** Without it,
`elevation.ts` falls back to live per-point queries against USGS's EPQS
service, which works but is slow on a cold cache (~1-2s per never-before-seen
50m sample) and was the whole reason this local-DEM system exists.

### Why a local raster instead of a live API

The live USGS EPQS point-query API (`elevation.ts`'s fallback path) is
correct but has real per-request network latency, and the trail network is
static — so instead, elevation for each park is downloaded once as a raster
grid and read locally (bilinear-interpolated, no network call) at request
time. Same underlying USGS 3DEP dataset either way; the difference is just
"live query" vs "downloaded once and read from disk."

### Fetching it

```
npx tsx src/scripts/fetchDem.ts <parkId>      # note: src/scripts/, not scripts/ — a separate location from the rest of this pipeline
npx tsx src/scripts/fetchDem.ts all           # every registered park
```

Source: USGS's public 3DEP ImageServer
(`elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage`),
requested at 1/3 arc-second (~10m) — the same national-baseline resolution
EPQS itself serves, not a downgrade. Resumable per-tile (safe to re-run or
Ctrl+C mid-fetch; already-fetched tiles are reused) and self-heals around
two distinct kinds of USGS flakiness discovered empirically — don't
"simplify" these away if you're refactoring this script, they're load-bearing:

- **`f=image` (direct binary response) is unreliable** — reproducibly 500s
  for some bbox/size combinations that succeed instantly via `f=json`
  (which returns a hosted href you then GET separately). The script always
  uses the two-step `f=json` → download approach; don't switch back to
  `f=image` even though it looks simpler.
- **Some specific region+size requests fail every single time**, independent
  of transient load (confirmed by hand: an ~9M-pixel Mount Rainier tile
  failed 8/8 retries at full size, but a quarter-size sub-region of the
  *exact same area* succeeded first try). Retries-with-backoff alone can't
  fix this class of failure — `fetchRasterResilient` recursively splits a
  region into quadrants once retries are exhausted, and keeps splitting
  until pieces are small enough to succeed. This fired correctly (no manual
  intervention needed) on Mount Rainier, Joshua Tree, Sierra National
  Forest, North Cascades, Yellowstone, and Inyo National Forest during the
  initial 11-park rollout — expect it to fire again on any new large/rugged
  park, that's normal, not a sign something's broken.

Large parks (100+ tiles for the biggest, e.g. Inyo National Forest) take
several minutes to fetch; ~10-15 minutes of one-time work is normal for a
huge park, not stuck.

### The Int16 overflow bug — verify this every time, it's silent

**Elevation is stored as Int16 (2 bytes/pixel) in whole meters.** It used to
be decimeters (0.1m precision, `scale=10` in the manifest) for extra
precision, which seemed reasonable until it silently corrupted 7 of our
first 11 parks:

Int16's range is ±32767. At decimeter scale, that caps representable
elevation at 32767/10 = **3276.7m (10,750ft)** — and a plain
`Int16Array` assignment doesn't error on overflow, it just wraps: an actual
reading of 4220.0m got stored as 42200 (decimeters), which wraps to -23336,
read back as **-2333.6m**. Any route touching terrain above that line got
wildly wrong, wildly *swinging* gain/loss (both hugely inflated, since each
wrapped point looks like a giant spurious climb immediately followed by an
equally giant spurious drop) — caught in production via Rocky Mountain's
Bear Lake Trailhead → North Inlet Junction reporting **24,318 ft of gain**
or a route that should have been ~2,800 ft.

**Parks confirmed affected** (real terrain above 3276.7m within their trail
network bbox): Rocky Mountain (Longs Peak 4346m — worst hit, 27% of all its
elevation pixels were corrupted), Yellowstone (Eagle Peak 3462m), Mount
Rainier (4392m summit), North Cascades, Sequoia/Kings Canyon and Inyo
National Forest (both touch the Whitney/High Sierra area, 4400m+), Sierra
National Forest. **Confirmed unaffected**: Grand Canyon (both), Zion, Joshua
Tree — their terrain never gets that high, but don't assume a future new
park is safe without checking; the whole point of the scanner below is to
not have to reason about this park-by-park from memory.

Storage is now whole meters (`scale=1`), which covers anything on Earth
(Everest is 8849m) at the identical 2-bytes/pixel cost — 1m precision is
already far finer than the elevation noise filter needs (see below), so
nothing was traded away to fix this.

**Always run this after fetching a new park**, before trusting its numbers:

```
npx tsx src/scripts/scanDemCorruption.ts
```

Flags any stored elevation below -500m as corruption (no real terrain in any
of our parks is anywhere close to that low, so it's a reliable tell) — a
clean run doesn't guarantee accuracy, but a corrupted one is a guaranteed
bug, and it's a 2-second check.

### Elevation noise filtering — why gain/loss isn't a naive sum

Summing every up/down step between consecutive elevation samples
over-counts gain/loss on any trail digitized as many short segments — a
real Grand Canyon example (Hermit's Rest → Hermit Creek Campsite) is 517 OSM
edges averaging ~22m each, and the raw per-vertex elevation noise on that
steep switchback terrain summed to 1287ft of spurious "gain" on a trail with
essentially no real climbing, inflating loss to match (net elevation change
is conserved, so spurious gain always drags loss up with it). Komoot
documents doing the same kind of correction ("removes virtual inclines").

The fix (`elevation.ts`) is a hysteresis/minimum-prominence filter run over
the *whole route's* concatenated elevation profile (not per-edge — a small
reversal spanning an edge boundary isn't visible from either edge's own
isolated samples). A point only counts as a new local peak/valley once
elevation has moved at least `NOISE_THRESHOLD_METERS` from the last one;
smaller reversals fold into the current trend. Critically, this never caps
a *sustained* real climb or descent — the running extreme keeps extending
for as long as the trend continues, so it only decides how big a reversal
has to be before it's a separate feature rather than trail-tread noise.

`NOISE_THRESHOLD_METERS = 25` was reached empirically, not guessed:
confirmed that sample spacing (tested 10m-300m) barely moves the number at
all — these OSM edges are already so short that coarser sampling just
returns the same two endpoints — only the reversal threshold matters. 25m
gets the Hermit's Rest example within ~4% of Komoot's reported number and
~12% of recreation.gov's (vs ~30% off unfiltered, ~20% off at a more
conservative 3m threshold). If you're tempted to push this higher to match
one specific route more closely: don't, without testing the effect on a
gentler, non-switchback trail first — a large threshold starts erasing real,
hiker-meaningful climbs on rolling terrain, not just DEM noise.

**This 25m value is now only the *default*, not universal.** Real
discrepancy-hunting against Komoot (Grand Canyon, Yellowstone) found that
pure threshold-tuning has a hard ceiling on rugged terrain: a real bump's
size determines, all-or-nothing, whether the threshold treats it as a
feature or discards it as noise, so gain and loss end up wanting different,
non-overlapping threshold values — no single number hits both. The fix is a
`movingAverage()` smoothing pass before the hysteresis filter, which turns
that hard jump into a gradual one, plus making the (smoothing window,
threshold) pair **per-park** via `PARK_FILTER_CONFIG` in `elevation.ts`
(keyed by `dataDir`) — Grand Canyon and Yellowstone's terrain each wanted a
visibly different pair, and forcing one global config on both made one of
them worse. A park not in that table keeps this original unsmoothed 25m
default. **Do this for every new park, not just the ones that turned out to
need it** — see step 12 below and `testing/README.md`'s "Tuning the
elevation filter for a park" for the actual sweep methodology (don't add a
park to `PARK_FILTER_CONFIG` without running it against real Komoot data
first).

## Dev-server process gotcha (unrelated to the scraping itself, but will bite you)

`tsx watch`'s actual child process does **not** match a
`ps aux | grep "tsx watch src/server"` pattern — only the wrapper does. A
stray child can survive a `kill` aimed at the wrapper and silently squat on
port 3001 across restarts, causing a *new* instance to build all graphs
successfully and then crash with `EADDRINUSE` at the very end (which looks
like "it worked, then broke" — misleading). Always check both:

```
pgrep -fl "src/server.ts"          # matches wrapper AND child
kill -9 <pids>                      # kill by exact PID, not by grep pattern match on the wrapper alone
```

**`tsx watch` only reacts to imported source-file changes, not data-file
edits.** Editing a park's `campsites.json`/`trails.geojson`/etc. does
nothing on its own — those are read once at boot via plain `fs` calls, not
imported modules, so the watcher has no reason to restart. `touch
src/server.ts` (or any `.ts` it imports) to force a reload after a data
edit. A full multi-park boot can take **1-2 minutes** with several large
parks registered (Yellowstone/Grand Canyon Full/Inyo are each 100k-1.4M
graph nodes) — that's normal, not a hang; wait for `[server] listening on
http://localhost:3001` in the log, don't assume it's stuck partway through
the per-park `[graph] ...` lines.

## Known perf fix that matters for any big new park

`shortestPath` (in `src/graph.ts`) used a proper binary min-heap — it used
to be a plain array with a full `.sort()` + `.shift()` every pop
(O(V·E log E)), which hard-hung on graphs bigger than Rocky Mountain's
~57k edges (confirmed broken at Yellowstone's ~198k edges). If routing ever
seems to hang on a new large park, check this hasn't regressed — it's not
something a new park's data can reintroduce, but worth knowing why it's a
heap and not a sorted array if you're touching that file.

## Quick reference: script → purpose

| Script | Purpose |
|---|---|
| `rec-gov-login.ts` | One-time interactive login (only needed if you hit an endpoint that actually requires auth) |
| `rec-gov-export-storage.ts` | Export cookies from the login profile to a reusable storage-state file |
| `rec-gov-inspect.ts <url>` | Debug helper: load a URL with the saved session, dump all XHR/fetch responses + screenshot + HTML |
| `scrape-permit-campsites.ts <permitId> <parkSlug>` | Scrape one specific permit |
| `scrape-all-backcountry-permits.ts` | Nationwide search + scrape every backcountry permit found, grouped by park |
| `build-shenandoah-zones.ts` | Worked example: fill zone-polygon representative points from NPS ArcGIS data (adapt per-park, not generic) |
| `build-park-network.ts <parkSlug> [padDegrees]` | Fetch OSM trails/roads for a park's bounding box |
| `fetch-park-boundary.ts <dataDir> "<query>"` | Fetch a park's own outer boundary polygon (via Nominatim) so the frontend can style out-of-park roads differently. Optional, but cheap and fixes real clutter — run for every new dispersed park |
| `check-snap-distances.ts <dataDir>` | Report how far each campsite is from the nearest trail/road edge |
| `verify-park-screenshot.ts <parkId>` | Screenshot a park's planner page (needs frontend dev server running) |
| `rebuild-from-raw.ts` | Regenerate campsites.json for every already-scraped park (except Shenandoah) from cached raw data — no network. Run after any fix to deriveRecords.ts/enrich.ts |
| `lib/deriveRecords.ts` | Single shared function turning one permit's raw payload into campsites.json records — both scrapers call this, never duplicate it inline |
| `lib/enrich.ts` | Lower-level shared helpers for starting-area derivation + closed detection, used by deriveRecords.ts |
| `../src/scripts/fetchDem.ts <parkId\|all>` | Download + convert local elevation raster for a park (USGS 3DEP). **Run for every new park.** |
| `../src/scripts/scanDemCorruption.ts` | Scan all fetched parks for Int16 wraparound corruption. **Run after every DEM fetch.** |
| `../../frontend/src/RotatedImageOverlay.ts` | Leaflet layer that warps an image to 3 lat/lon corners instead of an axis-aligned rectangle — renders a scanned zone map overlay (step 5) with its rotation/skew correction intact |
| `../src/scripts/warmElevationCache.ts <parkId\|all>` | Pre-warm the live-EPQS fallback cache for a park with no local DEM yet — mostly obsolete now that `fetchDem.ts` covers all 11 parks, but still correct if a park is ever registered without running `fetchDem.ts` first |


## Publishing elevation data

The app's demo-mode "Download elevation data" button (`backend/src/demDownload.ts`) fetches one
`dem-<dataDir>.tar.gz` per park from a GitHub release (default tag `dem-v1`). To (re)publish after
fetching or fixing a park's DEM:

```bash
backend/scripts/package-dem.sh /some/output/dir      # one archive per registered park that has dem/
gh release upload dem-v1 /some/output/dir/dem-<dataDir>.tar.gz --clobber
```

Asset names must stay `dem-<dataDir>.tar.gz`, with `dem/` as the archive's top-level folder. Run
`scanDemCorruption.ts` before packaging, as with any fetch. Release assets are limited to 2GB each.
