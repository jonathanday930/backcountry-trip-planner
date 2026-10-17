# Test routes for validating the routing/elevation engine

Real published backpacking itineraries for Grand Canyon (South Rim), Rocky
Mountain National Park, and Yellowstone, using stops that already exist in
each park's own `backend/data/<dataDir>/campsites.json`. Machine-readable
version with lat/lon: [`test-routes.json`](./test-routes.json).

Per-leg distance/elevation gain/loss comparison against Komoot lives in
`comparison-report.md` once generated (see `README.md` for the process).

## Grand Canyon — Corridor Classic (3 days / 2 nights)

| Leg | From | To |
|---|---|---|
| 1 | Bright Angel Trailhead | CIG – Havasupai Gardens Campground |
| 2 | CIG – Havasupai Gardens Campground | CBG – Bright Angel Campground |
| 3 | CBG – Bright Angel Campground | Bright Angel Trailhead |

## Grand Canyon — Hermit / Tonto Loop (5 days / 4 nights)

| Leg | From | To |
|---|---|---|
| 1 | Bright Angel Trailhead | CIG – Havasupai Gardens Campground |
| 2 | CIG – Havasupai Gardens Campground | BL4 – Horn Creek |
| 3 | BL4 – Horn Creek | BL7 – Monument Creek |
| 4 | BL7 – Monument Creek | BM7 – Hermit Creek |
| 5 | BM7 – Hermit Creek | Bright Angel Trailhead |

## Rocky Mountain — Fern Lake → Odessa Lake Traverse (2 days / 1 night)

| Leg | From | To |
|---|---|---|
| 1 | Fern Lake Trailhead | 028 – Fern Lake |
| 2 | 028 – Fern Lake | 030 – Odessa Lake |
| 3 | 030 – Odessa Lake | Bear Lake Trailhead |

## Rocky Mountain — Wild Basin → Thunder Lake (2 days / 1 night)

| Leg | From | To |
|---|---|---|
| 1 | Wild Basin Trailhead | 055 – Thunder Lake |
| 2 | 055 – Thunder Lake | Wild Basin Trailhead |

## Rocky Mountain — East Inlet → Lake Verna (2–3 days)

| Leg | From | To |
|---|---|---|
| 1 | East Inlet Trailhead | 062 – Lower East Inlet |
| 2 | 062 – Lower East Inlet | 067 – Upper East Inlet |
| 3 | 067 – Upper East Inlet | 068 – Lake Verna |
| 4 | 068 – Lake Verna | East Inlet Trailhead |

## Yellowstone — Black Canyon of the Yellowstone (3 days / 2 nights)

| Leg | From | To |
|---|---|---|
| 1 | Blacktail Creek Trailhead | 1Y1 – Turkey Pen |
| 2 | 1Y1 – Turkey Pen | 1Y5 – Yellowstone River Bridge |
| 3 | 1Y5 – Yellowstone River Bridge | Hellroaring Trailhead |

## Yellowstone — Bechler River Trail / Cascade Corner (5 days / 4 nights)

| Leg | From | To |
|---|---|---|
| 1 | Lone Star Trailhead | OA1 – Lone Star |
| 2 | OA1 – Lone Star | 9B5 – Colonnade Falls |
| 3 | 9B5 – Colonnade Falls | 9A3 – Dunanda Falls |
| 4 | 9A3 – Dunanda Falls | Bechler Ranger Station Trailhead |

## Glacier — Gunsight Pass Trail (3 days / 2 nights)

| Leg | From | To |
|---|---|---|
| 1 | Sperry Trail | SPE – Sperry |
| 2 | SPE – Sperry | ELL – Lake Ellen Wilson |
| 3 | ELL – Lake Ellen Wilson | GUN – Gunsight Lake |

## Glacier — Ptarmigan Tunnel / Belly River Traverse (3 days / 2 nights)

| Leg | From | To |
|---|---|---|
| 1 | Iceberg/Ptarmigan Trail | ELH – Elizabeth Lake Head |
| 2 | ELH – Elizabeth Lake Head | HEL – Helen Lake |
| 3 | HEL – Helen Lake | Belly River Trail |
