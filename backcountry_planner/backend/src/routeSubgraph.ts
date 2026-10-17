import { buildGraph, getManualConnectorPoints, shortestPath, attachPointToNetwork, type TrailGraph, type PathResult } from './graph.js'
import { haversineMeters, type LonLat } from './geo.js'
import type { Campsite, TrailFeature, TrailsGeoJson } from './types.js'

/**
 * Builds a routable graph scoped to just the area around a request's stops, instead of the
 * park's whole trail/road network — the dominant memory cost for a large park (Inyo's full graph
 * was ~1.4M nodes/edges, ~1.5GB resident, for a park whose typical route only ever touches a tiny
 * fraction of that). `buildGraph` itself is unchanged and doesn't know or care whether it's given
 * a whole park or a filtered slice of one.
 *
 * The one thing this can never be allowed to do is silently produce a *wrong* (truncated) route
 * because the box was too small. An earlier version of this file tried to detect that by checking
 * whether the computed path's nodes came close to the box's own edge ("boundary touch") — that
 * missed a real case found while verifying against this app's Komoot-accuracy harness: a Mount
 * Rainier leg (South Puyallup Trailhead -> Devil's Dream Camp) where the true shortest path uses a
 * trail branch that swings outside the padded box entirely, without any node of the (wrong, but
 * Dijkstra-valid-within-the-box) alternate path ever coming near the box's perimeter — nothing
 * about that alternate path *looked* truncated. Distance came out 0.33% longer and gain/loss both
 * dropped by an identical ~819ft (net elevation change preserved) — the signature of a genuinely
 * different, longer path, not sampling noise.
 *
 * The fix here is a convergence check instead of a geometric guess: run the search at two
 * independently-sized boxes and only trust the answer once expanding the box further stops
 * changing it. If a real trail branch was being excluded, a bigger box will find it and produce a
 * *different* (shorter) distance; only when two consecutive box sizes agree is the result trusted.
 * Worst case (never converges) falls back to the full unfiltered park — today's original
 * behavior — as a hard correctness guarantee, at the cost of a slower request, never a wrong one.
 */

interface BBox {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
}

const FLOOR_METERS = 900
const PAD_FRACTION = 0.25
const EXPAND_FACTOR = 2.2
const MAX_EXPANSIONS = 5
/** Two consecutive attempts' per-leg distances must agree within this many meters to be treated
 * as converged — generous enough to absorb the small edge-splitting/sampling differences that
 * come from feeding a different (bbox-filtered) feature set into `buildGraph` each time, but far
 * tighter than any real alternate-path difference (which run to hundreds+ of meters). */
const CONVERGENCE_TOLERANCE_METERS = 5
/** How far a stop is allowed to snap from its requested coordinate before treating this attempt's
 * box as inadequate (real snap distances in this app are typically under ~250m even on full-park
 * data — see check-snap-distances.ts — so anything past this on a filtered subgraph suggests the
 * relevant trail wasn't included, not that the snap is genuinely that far). */
const MAX_ACCEPTABLE_SNAP_METERS = 500
/** Small buffer forced into every attempt's box around each of the park's `MANUAL_CONNECTORS`
 * points, so a hand-verified real gap-crossing is never excluded just because it happens to sit
 * outside this particular request's stops. */
const CONNECTOR_FORCE_INCLUDE_METERS = 300

const METERS_PER_DEGREE_LAT = 110540

function metersToDegrees(meters: number, atLat: number): { lonDeg: number; latDeg: number } {
  return {
    lonDeg: meters / (111320 * Math.cos((atLat * Math.PI) / 180)),
    latDeg: meters / METERS_PER_DEGREE_LAT,
  }
}

function bboxFromPoints(points: LonLat[]): BBox {
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon
    if (p.lon > maxLon) maxLon = p.lon
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
  }
  return { minLon, maxLon, minLat, maxLat }
}

function padBBox(box: BBox, padMeters: number): BBox {
  const midLat = (box.minLat + box.maxLat) / 2
  const { lonDeg, latDeg } = metersToDegrees(padMeters, midLat)
  return { minLon: box.minLon - lonDeg, maxLon: box.maxLon + lonDeg, minLat: box.minLat - latDeg, maxLat: box.maxLat + latDeg }
}

function unionBBoxWithConnectors(box: BBox, parkId: string): BBox {
  const points = getManualConnectorPoints(parkId)
  if (points.length === 0) return box
  let { minLon, maxLon, minLat, maxLat } = box
  for (const p of points) {
    const { lonDeg, latDeg } = metersToDegrees(CONNECTOR_FORCE_INCLUDE_METERS, p.lat)
    minLon = Math.min(minLon, p.lon - lonDeg)
    maxLon = Math.max(maxLon, p.lon + lonDeg)
    minLat = Math.min(minLat, p.lat - latDeg)
    maxLat = Math.max(maxLat, p.lat + latDeg)
  }
  return { minLon, maxLon, minLat, maxLat }
}

function pointInBBox(lon: number, lat: number, box: BBox): boolean {
  return lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat
}

function initialPadMeters(stopPoints: LonLat[]): number {
  const box = bboxFromPoints(stopPoints)
  const diagonalMeters = haversineMeters({ lon: box.minLon, lat: box.minLat }, { lon: box.maxLon, lat: box.maxLat })
  return Math.max(FLOOR_METERS, PAD_FRACTION * diagonalMeters)
}

function filterFeaturesToBBox(features: TrailFeature[], box: BBox): TrailFeature[] {
  return features.filter((f) => f.geometry.coordinates.some(([lon, lat]) => pointInBBox(lon, lat, box)))
}

/** One requested stop, already resolved to a coordinate (from a known campsite, or parsed from a
 * raw "lat,lon" token) — resolving to a *node id* only happens once a graph exists, below. */
export interface ResolvedStop {
  token: string
  campsiteId?: string
  lon: number
  lat: number
}

export interface StopNode {
  token: string
  nodeId: string
}

/** `'same-node'` (both stops resolved to the same node — a valid zero-distance leg) and
 * `'no-route'` (genuinely no path exists, confirmed on the full unfiltered park — a real 404) are
 * deliberately distinct outcomes, not just two flavors of "no PathResult" — a caller conflating
 * them would either wrongly 404 a same-point leg or wrongly render a real routing failure as a
 * silent zero-distance leg. */
export type LegOutcome = { kind: 'same-node' } | { kind: 'path'; path: PathResult } | { kind: 'no-route' }

export interface RouteOnSubgraphResult {
  graph: TrailGraph
  stopNodes: StopNode[]
  legs: LegOutcome[]
  /** True if this fell all the way back to the full, unfiltered park (today's original behavior)
   * as the correctness backstop, rather than converging on a smaller scoped box. */
  usedFullParkFallback: boolean
}

/** Thrown when a stop can't be resolved onto the network at all, even on the full park (mirrors
 * today's "No trail edges available" case — a genuinely empty/broken park, not a scoping issue). */
export class UnroutableStopError extends Error {}

interface Attempt {
  graph: TrailGraph
  stopNodes: StopNode[]
  legs: LegOutcome[]
}

/** One box-sized attempt: builds the (possibly filtered) graph, resolves every stop, and runs
 * `shortestPath` leg by leg. Returns `null` if this box looks inadequate (a stop didn't resolve,
 * snapped implausibly far, or a leg found no path at all) — the caller's signal to expand and
 * retry rather than trust this attempt for the convergence check. */
function tryAttempt(
  features: TrailFeature[],
  requestedCampsites: Campsite[],
  parkId: string,
  stops: ResolvedStop[],
  requireFullConnectivity: boolean,
): Attempt | null {
  const graph = buildGraph({ type: 'FeatureCollection', features }, requestedCampsites, parkId)

  const stopNodes: StopNode[] = []
  for (const stop of stops) {
    let nodeId: string | undefined
    if (stop.campsiteId) {
      nodeId = graph.campsiteNodeIds.get(stop.campsiteId)
      if (!nodeId) {
        if (requireFullConnectivity) throw new UnroutableStopError(`Unknown stop "${stop.token}"`)
        return null
      }
    } else {
      try {
        nodeId = attachPointToNetwork(graph, { lon: stop.lon, lat: stop.lat })
      } catch {
        if (requireFullConnectivity) throw new UnroutableStopError(`Unknown stop "${stop.token}"`)
        return null
      }
    }
    const node = graph.nodes.get(nodeId)!
    if (!requireFullConnectivity && haversineMeters(stop, node) > MAX_ACCEPTABLE_SNAP_METERS) return null
    stopNodes.push({ token: stop.token, nodeId })
  }

  const legs: LegOutcome[] = []
  for (let i = 0; i < stopNodes.length - 1; i++) {
    if (stopNodes[i].nodeId === stopNodes[i + 1].nodeId) {
      legs.push({ kind: 'same-node' })
      continue
    }
    const path = shortestPath(graph, stopNodes[i].nodeId, stopNodes[i + 1].nodeId)
    if (!path) {
      if (requireFullConnectivity) {
        legs.push({ kind: 'no-route' })
        continue
      }
      return null
    }
    legs.push({ kind: 'path', path })
  }

  return { graph, stopNodes, legs }
}

function legDistances(legs: LegOutcome[]): number[] {
  return legs.map((l) => (l.kind === 'path' ? l.path.totalDistanceMeters : 0))
}

function distancesConverged(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => Math.abs(v - b[i]) < CONVERGENCE_TOLERANCE_METERS)
}

/**
 * Cache of *complete results* (not bare graphs) keyed by the exact requested stop coordinates,
 * rounded to a coarse grid so repeated/reloaded views of the same route share a hit. Caching the
 * finished result rather than a reusable graph sidesteps a real hazard: `attachPointToNetwork`
 * (used for raw map-clicked stops) mutates its graph in place, so a graph shared across different
 * requests would let one request's ad-hoc point leak into another's — caching only after every
 * stop is already fully resolved means a cache hit never mutates anything further.
 *
 * Size is estimated from `nodes.size + edges.length` (bytes/unit calibrated from this app's own
 * measured park graphs — Joshua Tree's 962,677 nodes+edges cost ~818MB resident, ~890 bytes/unit;
 * used at a slightly conservative 850 here) rather than tracked exactly, since the actual resident
 * cost of a `TrailGraph` (nested `Map`s of objects) isn't cheaply measurable at runtime the way a
 * DEM tile's raw byte length is.
 */
const ROUTE_CACHE_BUDGET_BYTES = (Number(process.env.ROUTE_SUBGRAPH_CACHE_MB) || 400) * 1024 * 1024
const BYTES_PER_GRAPH_UNIT = 850
const COORD_GRID_DECIMALS = 4 // ~11m

interface CacheEntry {
  result: RouteOnSubgraphResult
  sizeEstimate: number
}
const routeCache = new Map<string, CacheEntry>()
let routeCacheBytes = 0

function roundCoord(v: number): number {
  const factor = 10 ** COORD_GRID_DECIMALS
  return Math.round(v * factor) / factor
}

function cacheKeyForStops(parkId: string, stops: ResolvedStop[]): string {
  return `${parkId}:` + stops.map((s) => `${roundCoord(s.lon)},${roundCoord(s.lat)}`).join('|')
}

function cacheResult(key: string, result: RouteOnSubgraphResult): RouteOnSubgraphResult {
  const sizeEstimate = (result.graph.nodes.size + result.graph.edges.length) * BYTES_PER_GRAPH_UNIT
  routeCache.set(key, { result, sizeEstimate })
  routeCacheBytes += sizeEstimate
  while (routeCacheBytes > ROUTE_CACHE_BUDGET_BYTES && routeCache.size > 1) {
    const oldestKey = routeCache.keys().next().value!
    const oldest = routeCache.get(oldestKey)!
    routeCache.delete(oldestKey)
    routeCacheBytes -= oldest.sizeEstimate
  }
  return result
}

/**
 * Builds a graph scoped to the given stops (expanding, and ultimately falling back to the whole
 * park if needed) and resolves every stop to a node id on that same graph, with `shortestPath`
 * already run between consecutive stops. Only the campsites that are actually among the requested
 * stops are fed into `buildGraph` — no other campsite's node id is ever needed for one
 * `/api/route` call, and this also keeps the (otherwise O(campsites × edges), uncapped) snap loop
 * cheap regardless of how many campsites the full park has.
 */
export function buildRouteSubgraph(trails: TrailsGeoJson, allCampsites: Campsite[], parkId: string, stops: ResolvedStop[]): RouteOnSubgraphResult {
  const cacheKey = cacheKeyForStops(parkId, stops)
  const cached = routeCache.get(cacheKey)
  if (cached) {
    // Bump to most-recently-used.
    routeCache.delete(cacheKey)
    routeCache.set(cacheKey, cached)
    return cached.result
  }

  const stopPoints: LonLat[] = stops.map((s) => ({ lon: s.lon, lat: s.lat }))
  const requestedCampsites = allCampsites.filter((c) => stops.some((s) => s.campsiteId === c.id))

  let pad = initialPadMeters(stopPoints)
  let previous: Attempt | null = null

  for (let attemptNum = 1; attemptNum <= MAX_EXPANSIONS + 1; attemptNum++) {
    const isFallback = attemptNum > MAX_EXPANSIONS
    const features = isFallback
      ? trails.features
      : filterFeaturesToBBox(trails.features, unionBBoxWithConnectors(padBBox(bboxFromPoints(stopPoints), pad), parkId))

    const attempt = tryAttempt(features, requestedCampsites, parkId, stops, isFallback)

    if (isFallback) {
      // Correctness backstop: always trusted, regardless of convergence — this is exactly
      // today's original (whole-park) behavior.
      return cacheResult(cacheKey, { graph: attempt!.graph, stopNodes: attempt!.stopNodes, legs: attempt!.legs, usedFullParkFallback: true })
    }

    if (attempt && previous && distancesConverged(legDistances(previous.legs), legDistances(attempt.legs))) {
      return cacheResult(cacheKey, { graph: previous.graph, stopNodes: previous.stopNodes, legs: previous.legs, usedFullParkFallback: false })
    }

    previous = attempt
    pad *= EXPAND_FACTOR
  }

  // Unreachable: the last iteration (attemptNum = MAX_EXPANSIONS + 1) is always the fallback,
  // which always returns or throws above.
  throw new Error('buildRouteSubgraph: unreachable')
}

export type { PathResult }
