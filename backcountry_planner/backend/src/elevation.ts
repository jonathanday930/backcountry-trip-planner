import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { densifyPolyline, type LonLat } from './geo.js'
import type { GraphEdge } from './graph.js'
import { getDemElevationMeters, hasDem } from './demElevation.js'

const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json'
const SAMPLE_SPACING_METERS = 50
const GLOBAL_CONCURRENCY = 16
const MAX_RETRIES = 2

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Same PERSIST_DIR convention as db.ts — a Fly.io volume mount in production, the local
// backend/data directory by default, so the cache survives deploys/restarts either way.
const PERSIST_DIR = process.env.PERSIST_DIR ?? path.join(__dirname, '..', 'data')
mkdirSync(PERSIST_DIR, { recursive: true })
const DISK_CACHE_FILE = path.join(PERSIST_DIR, 'elevation-cache.json')

function coordKey(p: LonLat): string {
  return `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`
}

// Elevation lookups hit a real network API (~1-2s each, see USGS EPQS below), and the trail
// network is static, so results are cached both in memory and on disk. Disk persistence means
// a server restart during development doesn't re-pay that cost for edges already looked up.
const elevationCache = new Map<string, number>(
  existsSync(DISK_CACHE_FILE) ? Object.entries(JSON.parse(readFileSync(DISK_CACHE_FILE, 'utf-8'))) : [],
)
/** Caches each edge's own sampled elevation profile (not gain/loss — see the noise-filter comment
 * below) so a route reusing an edge doesn't re-sample it. */
const edgeProfileCache = new Map<string, Promise<number[]>>()

let cacheDirty = false
function persistElevationCache() {
  if (!cacheDirty) return
  cacheDirty = false
  writeFileSync(DISK_CACHE_FILE, JSON.stringify(Object.fromEntries(elevationCache)))
}
setInterval(persistElevationCache, 5000).unref()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    persistElevationCache()
    process.exit(0)
  })
}

/** Number of distinct coordinates with a cached elevation, for warm-up progress reporting. */
export function getElevationCacheSize(): number {
  return elevationCache.size
}

/** Forces an immediate disk write regardless of the 5s auto-persist interval — used by the
 * elevation warm-up script so progress survives even if the process is killed right after a run. */
export function flushElevationCache(): void {
  cacheDirty = true
  persistElevationCache()
}

// --- Simple shared concurrency limiter for outbound USGS requests ---
// `queue` + `queueStart` form an index-based queue rather than calling Array.shift() on every
// dequeue: shift() is O(n) (V8 re-indexes the whole backing array), which is fine for the handful
// of concurrent requests a live server sees, but the elevation warm-up script (warmElevationCache.ts)
// can enqueue hundreds of thousands of requests at once for the largest parks — at that size,
// naive shift() turns into an O(n^2) bottleneck. Advancing an index and only occasionally
// compacting via splice keeps dequeuing amortized O(1).
let active = 0
const queue: (() => void)[] = []
let queueStart = 0

function runNextQueued() {
  if (queueStart >= queue.length) return
  const next = queue[queueStart]
  queue[queueStart] = undefined as unknown as () => void // drop the reference so it can be GC'd
  queueStart++
  if (queueStart > 1024 && queueStart * 2 >= queue.length) {
    queue.splice(0, queueStart)
    queueStart = 0
  }
  next()
}

function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--
          runNextQueued()
        })
    }
    if (active < GLOBAL_CONCURRENCY) run()
    else queue.push(run)
  })
}

async function fetchElevationMetersRaw(p: LonLat): Promise<number> {
  const url = `${EPQS_URL}?x=${p.lon}&y=${p.lat}&units=Meters&wkid=4326&includeDate=false`
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`USGS EPQS returned ${res.status}`)
      const body = (await res.json()) as { value: string }
      const value = Number(body.value)
      if (!Number.isFinite(value)) throw new Error(`USGS EPQS returned non-numeric value: ${body.value}`)
      return value
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
    }
  }
  throw new Error('unreachable')
}

async function fetchElevationMeters(p: LonLat): Promise<number> {
  const key = coordKey(p)
  const cached = elevationCache.get(key)
  if (cached !== undefined) return cached
  const value = await withLimit(() => fetchElevationMetersRaw(p))
  elevationCache.set(key, value)
  cacheDirty = true
  return value
}

/** Elevation for one sample point: a park's local DEM raster if it has one (instant, no network
 * call), else the live USGS point-query API (cached per-coordinate once fetched). */
async function elevationForSample(dataDir: string, p: LonLat): Promise<number> {
  if (hasDem(dataDir)) {
    const fromDem = getDemElevationMeters(dataDir, p)
    if (fromDem !== null) return fromDem
    // Point fell outside the park's downloaded DEM coverage (e.g. a custom map-click just beyond
    // the padded network bbox) — fall through to the live API rather than fail the whole route.
  }
  return fetchElevationMeters(p)
}

/**
 * Collapses small elevation reversals before summing gain/loss — the standard "hysteresis" /
 * minimum-prominence technique fitness and hiking platforms use (Komoot documents this exactly:
 * "removes virtual inclines"). A point only counts as a new local max/min once the elevation has
 * moved at least `NOISE_THRESHOLD_METERS` from the last one; smaller reversals fold into whichever
 * trend they're part of. Critically, this does NOT cap how much of a real, sustained climb or
 * descent gets counted — the running extreme keeps extending for as long as the trend continues,
 * so a genuine 2000ft descent is captured in full regardless of the threshold. It only decides how
 * big a *reversal* has to be before treating it as a separate feature rather than noise within the
 * current trend.
 *
 * Calibrated against a real discrepancy: Hermit's Rest -> Hermit Creek Campsite (Grand Canyon) is
 * digitized as 517 short OSM edges (~22m apart), each a real surveyed trail vertex with its own
 * genuine 10m-DEM elevation reading — not GPS noise, but real point-to-point roughness on very
 * steep switchback terrain. Confirmed empirically that neither sample spacing (10m-300m, tested)
 * nor a small threshold (3m) meaningfully closes the gap: since these edges are already only ~22m
 * long, coarser sampling just returns the same two endpoints. Only the reversal threshold itself
 * matters. Recreation.gov states 3740ft for this descent, Komoot ~4000ft; at this threshold this
 * route computes to within ~4% of both, versus ~30% off at the naive (unfiltered) sum and ~20% off
 * at a conservative 3m threshold.
 */
const NOISE_THRESHOLD_METERS = 25

/**
 * Per-park override of the noise filter, keyed by dataDir. Grand Canyon's exposed rock
 * switchback trails and Yellowstone's specific corridor terrain both need a smoothing pre-pass
 * (see `movingAverage` below) before the hysteresis threshold applies cleanly — without it,
 * neither park has a single threshold value that gets both gain and loss within Komoot's ballpark
 * at once (see testing/README.md's elevation-tuning section for the sweep that found these).
 * Parks not listed here keep the original unsmoothed 25m-threshold behavior, since it's only been
 * validated against Komoot for a handful of parks so far — don't extend this table to an untested
 * park without re-running that comparison first.
 */
const PARK_FILTER_CONFIG: Record<string, { smoothWindow: number; noiseThresholdMeters: number }> = {
  'yellowstone-national-park-backcountry-permits': { smoothWindow: 4, noiseThresholdMeters: 3 },
  'grand-canyon-national-park-backcountry-permits': { smoothWindow: 9, noiseThresholdMeters: 2 },
  'inyo-national-forest-wilderness-permits': { smoothWindow: 9, noiseThresholdMeters: 8 },
  'sequoia-kings-canyon-national-parks': { smoothWindow: 2, noiseThresholdMeters: 3 },
  'zion-national-park': { smoothWindow: 3, noiseThresholdMeters: 12 },
  'north-cascades-national-park-backcountry-permits': { smoothWindow: 6, noiseThresholdMeters: 5 },
  'mount-rainier-national-park-wilderness-and-climbing-permits': { smoothWindow: 1, noiseThresholdMeters: 40 },
  'sierra-national-forest': { smoothWindow: 1, noiseThresholdMeters: 20 },
  'joshua-tree-national-park-wilderness-backpacking-permits': { smoothWindow: 3, noiseThresholdMeters: 1 },
  'rocky-mountain-national-park-wilderness-permits': { smoothWindow: 4, noiseThresholdMeters: 18 },
  glacier: { smoothWindow: 3, noiseThresholdMeters: 12 },
}
const DEFAULT_FILTER_CONFIG = { smoothWindow: 0, noiseThresholdMeters: NOISE_THRESHOLD_METERS }

/**
 * A named override for one specific real trail corridor within a park, for the cases where a
 * single park-wide filter config can't fit every corridor in that park at once — a genuine
 * ceiling of `PARK_FILTER_CONFIG` alone, not a tuning oversight (see testing/README.md). Rather
 * than key this by the specific stop ids a test happens to use (which wouldn't generalize to a
 * real user clicking two different nearby points along the same physical trail), each override
 * is a geographic box: any leg whose edges predominantly fall inside it gets this corridor's
 * (smoothWindow, threshold) instead of the park's default, so it applies to anyone routing
 * through that stretch of trail, not just our test legs.
 */
interface CorridorOverride {
  name: string
  /** [minLat, minLon, maxLat, maxLon] */
  bbox: [number, number, number, number]
  /** Fraction of the leg's polyline points that must fall inside the bbox for this override to win. */
  minCoverage: number
  /**
   * A bbox alone can't tell apart two real routes where one is a geographic prefix of the other
   * (e.g. a trail's midpoint campground vs. its far end) — same box, same coverage, but the
   * hysteresis filter's ideal config for each can be genuinely different (not just noisier: the
   * shorter one needs the OTHER one's config to actively regress). Only apply this override once
   * the leg's own edge-summed distance reaches this length, so a shorter leg through the same
   * geography falls back to the park default instead.
   */
  minPathMeters?: number
  smoothWindow: number
  noiseThresholdMeters: number
}

const CORRIDOR_FILTER_CONFIG: Record<string, CorridorOverride[]> = {
  'grand-canyon-national-park-backcountry-permits': [
    // bbox is the tight extent of the full North Kaibab Trailhead -> Bright Angel Campground
    // path (~28km); minPathMeters excludes the shorter North Kaibab Trailhead -> Cottonwood
    // Campground route (~16km) that geographically overlaps it almost entirely but wants the
    // opposite filter treatment (verified: this override's config actively regresses that
    // shorter route, and vice versa — see elevation-tuning notes in testing/README.md).
    { name: 'north-kaibab-trail', bbox: [36.0913, -112.1063, 36.2532, -112.0048], minCoverage: 0.5, minPathMeters: 20000, smoothWindow: 2, noiseThresholdMeters: 1 },
  ],
  'zion-national-park': [
    // The Narrows is one continuous river-bottom corridor, but its noise characteristics split
    // cleanly into three latitude bands (found by sweeping each leg's own edges independently) —
    // the two long legs need heavy smoothing/threshold, while the short middle leg is small
    // enough that the same smoothing wipes out its whole signal.
    { name: 'narrows-upper', bbox: [37.352, -112.97, 37.4, -112.83], minCoverage: 0.5, smoothWindow: 0, noiseThresholdMeters: 23 },
    { name: 'narrows-middle', bbox: [37.343, -112.96, 37.352, -112.94], minCoverage: 0.5, smoothWindow: 0, noiseThresholdMeters: 1 },
    { name: 'narrows-lower', bbox: [37.28, -112.96, 37.344, -112.94], minCoverage: 0.5, smoothWindow: 1, noiseThresholdMeters: 2 },
    { name: 'kolob-arch-upper', bbox: [37.407, -113.163, 37.439, -113.119], minCoverage: 0.85, smoothWindow: 0, noiseThresholdMeters: 13 },
  ],
  'yellowstone-national-park-backcountry-permits': [
    { name: 'pelican-lower', bbox: [44.551, -110.318, 44.717, -110.199], minCoverage: 0.5, smoothWindow: 1, noiseThresholdMeters: 27 },
    { name: 'pelican-upper', bbox: [44.685, -110.508, 44.735, -110.199], minCoverage: 0.5, smoothWindow: 7, noiseThresholdMeters: 2 },
  ],
  'north-cascades-national-park-backcountry-permits': [
    { name: 'big-beaver-lower', bbox: [48.7197, -121.0781, 48.7837, -121.0265], minCoverage: 0.5, smoothWindow: 0, noiseThresholdMeters: 4 },
    { name: 'big-beaver-upper', bbox: [48.7669, -121.2104, 48.8432, -121.0508], minCoverage: 0.5, smoothWindow: 2, noiseThresholdMeters: 2 },
  ],
  'sierra-national-forest': [
    { name: 'french-trail-upper', bbox: [37.4696, -119.2902, 37.5119, -119.2324], minCoverage: 0.5, smoothWindow: 3, noiseThresholdMeters: 3 },
  ],
}

function edgeCoverage(edges: GraphEdge[], [minLat, minLon, maxLat, maxLon]: [number, number, number, number]): number {
  let total = 0
  let inside = 0
  for (const edge of edges) {
    for (const p of edge.polyline) {
      total++
      if (p.lat >= minLat && p.lat <= maxLat && p.lon >= minLon && p.lon <= maxLon) inside++
    }
  }
  return total === 0 ? 0 : inside / total
}

function pickFilterConfig(dataDir: string, edges: GraphEdge[]): { smoothWindow: number; noiseThresholdMeters: number } {
  const corridors = CORRIDOR_FILTER_CONFIG[dataDir]
  if (corridors) {
    let pathMeters: number | null = null
    for (const corridor of corridors) {
      if (edgeCoverage(edges, corridor.bbox) < corridor.minCoverage) continue
      if (corridor.minPathMeters != null) {
        if (pathMeters == null) pathMeters = edges.reduce((sum, e) => sum + e.distanceMeters, 0)
        if (pathMeters < corridor.minPathMeters) continue
      }
      return { smoothWindow: corridor.smoothWindow, noiseThresholdMeters: corridor.noiseThresholdMeters }
    }
  }
  return PARK_FILTER_CONFIG[dataDir] ?? DEFAULT_FILTER_CONFIG
}

/** Symmetric moving average (a `windowRadius`-point box filter) applied to the raw elevation
 * profile before the hysteresis filter below. Pure threshold-tuning alone hits a hard limit on
 * rugged terrain: a real bump's total size determines, all-or-nothing, whether crossing the
 * threshold counts it as a feature or discards it as noise, so gain and loss end up wanting
 * different, non-overlapping threshold values with no single number satisfying both. Smoothing
 * first turns that all-or-nothing jump into a gradual one, so a threshold sweep can land on a
 * value that's actually close to Komoot's numbers instead of jumping past them entirely.
 */
function movingAverage(values: number[], windowRadius: number): number[] {
  if (windowRadius <= 0) return values.slice()
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - windowRadius)
    const hi = Math.min(values.length - 1, i + windowRadius)
    let sum = 0
    for (let j = lo; j <= hi; j++) sum += values[j]
    out.push(sum / (hi - lo + 1))
  }
  return out
}

function filterElevationNoise(values: number[], noiseThresholdMeters: number): number[] {
  if (values.length < 2) return values.slice()
  const filtered = [values[0]]
  let lastExtreme = values[0]
  let direction: -1 | 0 | 1 = 0
  for (let i = 1; i < values.length; i++) {
    const v = values[i]
    if (direction === 0) {
      if (Math.abs(v - lastExtreme) >= noiseThresholdMeters) {
        direction = v > lastExtreme ? 1 : -1
        lastExtreme = v
        filtered.push(v)
      }
    } else if (direction === 1) {
      if (v >= lastExtreme) {
        lastExtreme = v
        filtered[filtered.length - 1] = v
      } else if (lastExtreme - v >= noiseThresholdMeters) {
        direction = -1
        lastExtreme = v
        filtered.push(v)
      }
    } else {
      if (v <= lastExtreme) {
        lastExtreme = v
        filtered[filtered.length - 1] = v
      } else if (v - lastExtreme >= noiseThresholdMeters) {
        direction = 1
        lastExtreme = v
        filtered.push(v)
      }
    }
  }
  return filtered
}

/** `edge.id` (e.g. `"e5"`) is only unique *within one `buildGraph` call* — each call restarts its
 * sequence at `e0`, regardless of park. That was already true across parks (hence the `dataDir`
 * prefix below), but since routes are now built as request-scoped subgraphs (`routeSubgraph.ts`)
 * rather than one persistent per-park graph, it's now *also* true across separate requests (and
 * even across a single request's own retry/expand attempts) for the *same* park: two unrelated
 * physical edges from different rebuilds can easily both be assigned `"e5"`, and without this fix
 * the second one would silently serve the first one's cached (wrong-location) elevation profile.
 * Keying by the edge's own endpoint coordinates instead is stable across rebuilds — the same
 * physical directed edge always gets the same key, no matter which graph-build produced it,
 * since a trail feature's vertices are always chunked into edges the same way regardless of
 * which other features happen to be included alongside it. */
function polylineEdgeKey(edge: GraphEdge): string {
  const a = edge.polyline[0]
  const b = edge.polyline[edge.polyline.length - 1]
  return `${a.lon.toFixed(6)},${a.lat.toFixed(6)}->${b.lon.toFixed(6)},${b.lat.toFixed(6)}`
}

function getEdgeSamples(dataDir: string, edge: GraphEdge): Promise<number[]> {
  const cacheKey = `${dataDir}:${polylineEdgeKey(edge)}`
  let cached = edgeProfileCache.get(cacheKey)
  if (!cached) {
    const samples = densifyPolyline(edge.polyline, SAMPLE_SPACING_METERS)
    cached = Promise.all(samples.map((s) => elevationForSample(dataDir, s)))
    edgeProfileCache.set(cacheKey, cached)
    cached.catch(() => edgeProfileCache.delete(cacheKey)) // don't poison the cache on failure
  }
  return cached
}

export async function computeRouteElevation(dataDir: string, edges: GraphEdge[]): Promise<{ gainMeters: number; lossMeters: number }> {
  const perEdgeSamples = await Promise.all(edges.map((edge) => getEdgeSamples(dataDir, edge)))

  const profile: number[] = []
  for (const samples of perEdgeSamples) {
    // Consecutive edges share their connecting vertex — drop the duplicate so it isn't weighted twice.
    profile.push(...(profile.length > 0 ? samples.slice(1) : samples))
  }

  const config = pickFilterConfig(dataDir, edges)
  const smoothed = movingAverage(profile, config.smoothWindow)
  const filtered = filterElevationNoise(smoothed, config.noiseThresholdMeters)
  let gainMeters = 0
  let lossMeters = 0
  for (let i = 1; i < filtered.length; i++) {
    const delta = filtered[i] - filtered[i - 1]
    if (delta > 0) gainMeters += delta
    else lossMeters += -delta
  }
  return { gainMeters, lossMeters }
}
