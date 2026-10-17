import type { BoundaryGeoJson, Campsite, TrailsGeoJson, ZonesGeoJson } from './types.js'
import { PARKS } from './parks.js'
import { loadParkData } from './parkNetwork.js'
import type { ResolvedStop } from './routeSubgraph.js'

/** stops are "|"-separated; each token is either a known campsite id, or a raw "lat,lon" point. */
const RAW_POINT_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

export interface ParkState {
  id: string
  dataDir: string
  campsites: Campsite[]
  trails: TrailsGeoJson
  zones: ZonesGeoJson
  boundary: BoundaryGeoJson
}

/** Loaded lazily on first request for a park, then cached forever — this data (campsites/trails/
 * roads/zones/boundary, no built graph) is cheap even for the largest currently-registered park
 * (~43MB raw), so unlike the routing graph it was never worth evicting, only worth not loading
 * for a park nobody's actually looked at yet.
 *
 * Extracted out of server.ts (originally private there) so tool implementations under
 * `backend/src/tools/` and `itinerarySolver.ts` can resolve a park's stops/data the same way the
 * HTTP routes do, without duplicating this cache or re-parsing GeoJSON per tool call. */
const parkStates = new Map<string, ParkState>()

export function getOrLoadParkState(parkId: string): ParkState | null {
  const cached = parkStates.get(parkId)
  if (cached) return cached

  const park = PARKS.find((p) => p.id === parkId)
  if (!park) return null

  const { campsites, trails, zones, boundary } = loadParkData(park)
  const state: ParkState = { id: park.id, dataDir: park.dataDir, campsites, trails, zones, boundary }
  parkStates.set(park.id, state)
  const roadCount = trails.features.filter((f) => f.properties.kind === 'road').length
  console.log(`[park-data] ${park.id}: ${campsites.length} campsites, ${trails.features.length - roadCount} trail features, ${roadCount} road segments`)
  return state
}

/** Resolves a stop token to a coordinate — either a known campsite's own lat/lon, or a raw
 * "lat,lon" point — *before* any graph exists, since the graph itself is built per-request,
 * scoped to wherever the stops actually are (see `routeSubgraph.ts`). */
export function resolveStopCoordinate(campsites: Campsite[], token: string): ResolvedStop | null {
  const campsite = campsites.find((c) => c.id === token)
  if (campsite) return { token, campsiteId: campsite.id, lon: campsite.lon, lat: campsite.lat }

  const match = token.match(RAW_POINT_RE)
  if (match) {
    const lat = Number(match[1])
    const lon = Number(match[2])
    return { token, lon, lat }
  }
  return null
}
