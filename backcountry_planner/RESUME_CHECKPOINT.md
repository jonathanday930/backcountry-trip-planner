# Codex resume checkpoint

Last checkpoint: 2026-09-09 13:55 MDT (America/Denver), Codex session `01a08414-4409-7a03-a06c-cf1236a9172c`.

## Active objective

Implement and validate the 12 selected national-park backpacking areas in three batches of four, including permit/campsite data, trail/road networks, boundaries, DEMs, popular routes, Komoot backtests, and official at-large zone maps where available.

## Current batch

Batch 1: Great Smoky Mountains, Canyonlands, Olympic, Yosemite. Olympic is validated; Canyonlands is locally populated and route-validated; Great Smoky awaits DEM retry; Yosemite is scaffolded and awaits DEM/route validation.

## Olympic state

- Registry entry added in `backend/src/parks.ts`.
- Permit raw data and 299 permit-division mappings saved under `backend/data/olympic-national-park/`.
- `enrich-olympic-campsites.ts` added and run against NPS ArcGIS: 119 campsite coordinate matches and 46 NPS trailheads added. Twelve raw trailhead names remain unmatched.
- Corrected OSM network rebuilt: 32,884 trail features and 67,894 road features.
- Boundary saved from OSM relation 163769.
- Four popular routes added to `backend/data/olympic-national-park/known-routes.json` and `testing/test-routes.json`.
- Official wilderness map image saved as `frontend/public/zone-overlays/olympic.jpg`.
- Official Olympic NPS map config identifies KML sources for quota and non-quota camp areas; these still need converting into `zones.geojson` and wiring into the app as appropriate.
- Fresh corrected DEM fetch was paused at tile 27/42. There is no manifest yet. Completed tile files remain in `backend/data/olympic-national-park/dem/`; rerun `npx tsx src/scripts/fetchDem.ts olympic` to resume/reuse them. The prior DEM is preserved in `dem-before-coordinate-enrichment/`.
- Dev server and DEM process were stopped. The prior server had loaded the old network and its known-routes request failed on `cape-alava`; restart only after the fresh DEM/network validation.

## Great Smoky Mountains state

- Registry entry added in `backend/src/parks.ts`.
- `enrich-great-smoky-campsites.ts` added and run against the official NPS GRSM ArcGIS service: all 103 backcountry divisions matched (89 campsites and 14 shelters); 71 of 90 permit trailheads matched conservatively.
- Network and boundary saved: 3,142 trails, 26,879 road segments, NPS/OSM boundary relation 2131838.
- Four curated route definitions added to `backend/data/great-smoky-mountains-national-park/known-routes.json` and four test routes added to `testing/test-routes.json`.
- Snap audit passed with 36 campsite spur edges; largest distances are boat-access sites (731m and 652m), not curated trail corridor sites.
- Great Smoky DEM fetch was attempted but the USGS ImageServer repeatedly returned 502/504 even after recursive tile splitting; no usable manifest exists yet. Retry before route/elevation validation.

## Canyonlands state

- Registry entry added in `backend/src/parks.ts`.
- `build-canyonlands-zones.ts` added and run against all four official NPS KMZ files, producing 54 polygon/multi-polygon features in `backend/data/canyonlands-national-park-overnight-backcountry-permits/zones.geojson`.
- `enrich-canyonlands-campsites.ts` added and run against OSM camp nodes/trailheads: 76/86 divisions matched and 79 records written, including 10 at-large zone representative points; no zero coordinates remain.
- Network and boundary saved: 257 trails, 555 road segments, NPS/OSM boundary relation 13624591.
- Canyonlands DEM completed in tool session `2138`: 9 tiles, 176.4 MB. Corruption scan is clean (0/92,471,166 implausible pixels).
- Four Canyonlands known routes are saved and all compute successfully through `/api/known-routes?park=canyonlands`: Salt Creek 8.55 mi, White Rim corridor 50.28 mi, Maze corridor 29.85 mi, and Devils Kitchen corridor 0.15 mi.
- Canyonlands Komoot first backtest completed with coordinate-input timeouts on all legs and was saved; after making the selector whitespace-tolerant, a second run produced null stats rather than selector exceptions but was manually stopped during the long retry sequence before its results file was written. Local route results were fetched and comparison report regenerated from the saved first pass.

## Next steps

1. Retry Great Smoky DEM when the USGS service recovers; then validate its four routes and run Komoot.
2. Yosemite is scaffolded: OSM camps/trailheads, network, boundary, four route fixtures, and official NPS wilderness-trailhead overlay. Its DEM fetch was stopped during the first tile pass; no Yosemite DEM tiles or manifest were present on disk, so rerun `npx tsx src/scripts/fetchDem.ts yosemite` on resume.
3. Investigate/fix the Komoot null-stats behavior before claiming external backtesting for Olympic/Canyonlands; the second Canyonlands rerun was stopped after confirming selector errors were fixed.
4. Finish Olympic documentation/source notes and decide whether its official campsite-point KMLs should be represented as a point layer rather than inaccurate zone polygons.
4. Decide/document Olympic's zone-map limitation: the official quota/non-quota KMLs are campsite points, not zone polygons; the official scanned map is saved but not georeferenced as a polygon overlay.
5. Implement Yosemite from its official wilderness trailhead map and NPS/OSM data, then continue the remaining parks.

## Important preservation notes

The worktree was already very dirty with staged and unstaged project changes. Preserve unrelated changes; do not reset or clean the worktree. The stopped DEM files are recoverable and should not be deleted.

## Pause note

Paused cleanly at the checkpoint timestamp above. No development server or DEM process is running. Resume from the Next steps section; all project changes and this checkpoint are saved in the worktree.
