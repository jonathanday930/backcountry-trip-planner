import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { densifyPolyline, type LonLat } from './geo.js'
import type { GraphEdge } from './graph.js'

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
/** Caches computed gain/loss per edge id so a route reusing an edge doesn't recompute it. */
const edgeProfileCache = new Map<string, Promise<{ gainMeters: number; lossMeters: number }>>()

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

// --- Simple shared concurrency limiter for outbound USGS requests ---
let active = 0
const queue: (() => void)[] = []

function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--
          const next = queue.shift()
          if (next) next()
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

async function computeEdgeProfile(edge: GraphEdge): Promise<{ gainMeters: number; lossMeters: number }> {
  const samples = densifyPolyline(edge.polyline, SAMPLE_SPACING_METERS)
  const elevations = await Promise.all(samples.map((s) => fetchElevationMeters(s)))
  let gain = 0
  let loss = 0
  for (let i = 1; i < elevations.length; i++) {
    const delta = elevations[i] - elevations[i - 1]
    if (delta > 0) gain += delta
    else loss += -delta
  }
  return { gainMeters: gain, lossMeters: loss }
}

function getEdgeProfile(edge: GraphEdge): Promise<{ gainMeters: number; lossMeters: number }> {
  let cached = edgeProfileCache.get(edge.id)
  if (!cached) {
    cached = computeEdgeProfile(edge)
    edgeProfileCache.set(edge.id, cached)
    cached.catch(() => edgeProfileCache.delete(edge.id)) // don't poison the cache on failure
  }
  return cached
}

export async function computeRouteElevation(edges: GraphEdge[]): Promise<{ gainMeters: number; lossMeters: number }> {
  const profiles = await Promise.all(edges.map((edge) => getEdgeProfile(edge)))
  return profiles.reduce(
    (acc, p) => ({ gainMeters: acc.gainMeters + p.gainMeters, lossMeters: acc.lossMeters + p.lossMeters }),
    { gainMeters: 0, lossMeters: 0 },
  )
}
