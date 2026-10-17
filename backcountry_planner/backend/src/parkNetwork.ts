import { loadBoundary, loadCampsites, loadRoads, loadTrails, loadZones } from './data.js'
import { buildGraph, type TrailGraph } from './graph.js'
import { pointInGeometry, simplifyRing } from './geo.js'
import type { BoundaryGeoJson, Campsite, TrailFeature, TrailsGeoJson, ZonesGeoJson } from './types.js'
import type { ParkConfig } from './parks.js'

export interface ParkNetwork {
  campsites: Campsite[]
  trails: TrailsGeoJson
  zones: ZonesGeoJson
  boundary: BoundaryGeoJson
  graph: TrailGraph
}

/** Tolerance for `simplifyRing` below — see that function's doc comment for why this is safe. */
const BOUNDARY_STYLE_SIMPLIFY_METERS = 100

interface BBox {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
}

function ringBBox(ring: number[][]): BBox {
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, maxLon, minLat, maxLat }
}

function inBBox(lon: number, lat: number, box: BBox): boolean {
  return lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat
}

/**
 * Tags every road feature with whether it falls inside the park's own boundary (as opposed to an
 * OSM road network that spills into a padded bounding box around the park — see
 * `backend/scripts/README.md`). Every road is equally routable regardless of the answer; this only
 * decides how the frontend styles the line. Computed once here, at boot, rather than by the
 * frontend on every React re-render: a naive per-render point-in-polygon check against Grand
 * Canyon's 44k-vertex boundary ring measured at 8+ seconds of blocked main-thread time *per
 * re-render* (any stop edit, search keystroke, or map click), which is what made the map feel
 * unusable.
 *
 * Two cost-cutting steps, both needed — simplification alone still wasn't enough once National
 * Forest parks were added: Inyo's boundary is a 30-part `MultiPolygon` (scattered parcels) checked
 * against ~33k road features, so a naive "run the ray-cast against every sub-polygon" still blew up
 * even after simplifying each ring:
 * 1. Each ring is simplified (see `simplifyRing`'s doc comment for why ~100m tolerance is fine for
 *    a styling-only decision).
 * 2. Each sub-polygon's outer-ring bounding box is precomputed once, so a road point clearly
 *    outside a given parcel's bbox skips that parcel's ray-cast entirely — the common case for a
 *    park whose boundary is many disjoint parcels, since any given road is only ever near one of them.
 */
function tagRoadsInsideBoundary(features: TrailFeature[], boundary: BoundaryGeoJson): TrailFeature[] {
  if (boundary.features.length === 0) return features

  const polygons: { rings: number[][][]; bbox: BBox }[] = []
  for (const f of boundary.features) {
    const polygonRingSets = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const rings of polygonRingSets) {
      const simplifiedRings = rings.map((ring) => simplifyRing(ring, BOUNDARY_STYLE_SIMPLIFY_METERS))
      polygons.push({ rings: simplifiedRings, bbox: ringBBox(simplifiedRings[0]) })
    }
  }

  return features.map((f) => {
    if (f.properties.kind !== 'road') return f
    const coords = f.geometry.coordinates
    if (coords.length === 0) return f
    const [lon, lat] = coords[Math.floor(coords.length / 2)]
    const inside = polygons.some(
      ({ rings, bbox }) => inBBox(lon, lat, bbox) && pointInGeometry(lon, lat, { type: 'Polygon', coordinates: rings }),
    )
    return { ...f, properties: { ...f.properties, insideBoundary: inside } }
  })
}

function loadParkDataUncached(park: ParkConfig): Omit<ParkNetwork, 'graph'> {
  const campsites = loadCampsites(park.dataDir)
  const trails = loadTrails(park.dataDir)
  const roads = loadRoads(park.dataDir)
  const zones = loadZones(park.dataDir)
  const boundary = loadBoundary(park.dataDir)
  // Roads (e.g. an unpaved trailhead access road) are just as walkable as trails, so they're
  // merged into one network graph; `kind` is kept on each feature so the frontend can still draw
  // trails and roads with distinct line styles.
  const trailsAndRoads: TrailsGeoJson = {
    type: 'FeatureCollection',
    features: tagRoadsInsideBoundary(
      [
        ...trails.features.map((f) => ({ ...f, properties: { ...f.properties, kind: 'trail' as const } })),
        ...roads.features.map((f) => ({ ...f, properties: { ...f.properties, kind: 'road' as const } })),
      ],
      boundary,
    ),
  }
  return { campsites, trails: trailsAndRoads, zones, boundary }
}

/**
 * Loads a park's campsites/trails/roads/zones — everything `/api/trails`, `/api/campsites`,
 * `/api/zones`, and `/api/boundary` need, and (via `routeSubgraph.ts`) everything `/api/route`
 * needs too, now that routing builds its own small request-scoped graph instead of one persistent
 * per-park graph. No `buildGraph` call here at all — this alone is what `server.ts` lazy-loads
 * per park on first request (see `getOrLoadParkData` there), since the raw data is cheap (~110MB
 * total across every currently-registered park) compared to a *built graph* (Joshua Tree's graph
 * alone was ~818MB resident for ~20MB of raw trails+roads — the routing-side memory cost was
 * never this data, it was building a graph out of all of it eagerly for every park at once).
 */
export function loadParkData(park: ParkConfig): Omit<ParkNetwork, 'graph'> {
  return loadParkDataUncached(park)
}

/**
 * Loads a park's data *and* builds its full, whole-park routable graph — the pre-refactor
 * behavior, still correct and still used by every one-park-at-a-time standalone script
 * (`warmElevationCache.ts`, `diagnoseRoutingGap.ts`, `sweepElevationFilter.ts`,
 * `check-snap-distances.ts`) where building the whole graph once is exactly what's wanted. Not
 * used by `server.ts` anymore — see `loadParkData` above.
 */
export function loadParkNetwork(park: ParkConfig): ParkNetwork {
  const data = loadParkDataUncached(park)
  const graph = buildGraph(data.trails, data.campsites, park.id)
  return { ...data, graph }
}
