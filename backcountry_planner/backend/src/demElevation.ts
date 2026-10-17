import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LonLat } from './geo.js'
import { DEM_DIR_NAME, MANIFEST_FILE_NAME, type DemManifest, type DemTileMeta } from './dem/manifest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

/** Manifests are tiny (just tile bboxes/dimensions, no pixel data) — cached forever per park,
 * no eviction needed. This is also what `hasDem`/`findTile` need, so a park with no DEM yet is
 * only ever charged one failed `existsSync` check, not repeated per elevation sample. */
const manifestCache = new Map<string, DemManifest | null>()

function loadManifest(dataDir: string): DemManifest | null {
  if (manifestCache.has(dataDir)) return manifestCache.get(dataDir)!
  const manifestPath = path.join(DATA_DIR, dataDir, DEM_DIR_NAME, MANIFEST_FILE_NAME)
  if (!existsSync(manifestPath)) {
    manifestCache.set(dataDir, null)
    return null
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DemManifest
  manifestCache.set(dataDir, manifest)
  return manifest
}

/** Whether a park has a local elevation raster downloaded (see fetchDem.ts) — if not, callers should fall back to the live USGS API. */
export function hasDem(dataDir: string): boolean {
  return loadManifest(dataDir) !== null
}

/**
 * Actual pixel data is loaded per-tile, not per-park: a park's tiles are already split into
 * separate files with known bboxes (`manifest.tiles`), and any single elevation query only ever
 * needs the one tile a point falls in (`findTile` below) — so eagerly reading every tile the
 * first time *any* point in a park is queried was pure waste. Inyo National Forest alone has 63
 * tiles totaling 1.5GB on disk; a typical route only ever touches a handful of them.
 *
 * LRU by access order (`Map` re-insertion bumps to MRU on hit), evicted by a real byte budget —
 * tile size is known exactly from `width*height*2` before reading, so eviction tracks an exact
 * running total rather than an approximate one.
 */
const TILE_CACHE_BUDGET_BYTES = (Number(process.env.DEM_TILE_CACHE_MB) || 450) * 1024 * 1024
const tileCache = new Map<string, Int16Array>()
let tileCacheBytes = 0

function tileCacheKey(dataDir: string, tileIndex: number): string {
  return `${dataDir}:${tileIndex}`
}

function loadTile(dataDir: string, demDir: string, tileIndex: number, meta: DemTileMeta): Int16Array {
  const key = tileCacheKey(dataDir, tileIndex)
  const cached = tileCache.get(key)
  if (cached) {
    // Bump to most-recently-used.
    tileCache.delete(key)
    tileCache.set(key, cached)
    return cached
  }

  const buf = readFileSync(path.join(demDir, meta.file))
  const tile = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
  tileCache.set(key, tile)
  tileCacheBytes += tile.byteLength

  while (tileCacheBytes > TILE_CACHE_BUDGET_BYTES && tileCache.size > 1) {
    const oldestKey = tileCache.keys().next().value!
    const oldest = tileCache.get(oldestKey)!
    tileCache.delete(oldestKey)
    tileCacheBytes -= oldest.byteLength
  }

  return tile
}

function findTile(tiles: DemTileMeta[], p: LonLat): number {
  for (let i = 0; i < tiles.length; i++) {
    const [lonMin, lonMax, latMin, latMax] = tiles[i].nominalBbox
    if (p.lon >= lonMin && p.lon <= lonMax && p.lat >= latMin && p.lat <= latMax) return i
  }
  return -1
}

function bilinearSample(data: Int16Array, meta: DemTileMeta, p: LonLat): number {
  const [lonMin, lonMax, latMin, latMax] = meta.bbox
  const { width, height } = meta

  // Pixel-center convention: pixel (col, row)'s center sits at lon = lonMin + (col+0.5)/width * extent,
  // lat = latMax - (row+0.5)/height * extent (row 0 is the northernmost row).
  let fx = ((p.lon - lonMin) / (lonMax - lonMin)) * width - 0.5
  let fy = ((latMax - p.lat) / (latMax - latMin)) * height - 0.5
  fx = Math.max(0, Math.min(width - 1.0001, fx))
  fy = Math.max(0, Math.min(height - 1.0001, fy))

  const col0 = Math.floor(fx)
  const row0 = Math.floor(fy)
  const tx = fx - col0
  const ty = fy - row0
  const col1 = Math.min(width - 1, col0 + 1)
  const row1 = Math.min(height - 1, row0 + 1)

  const v00 = data[row0 * width + col0]
  const v10 = data[row0 * width + col1]
  const v01 = data[row1 * width + col0]
  const v11 = data[row1 * width + col1]

  return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
}

/** Returns the elevation in meters at `p` from the park's local DEM raster, or null if this park
 * has no DEM yet, or the point falls outside its covered area (callers should fall back to the
 * live USGS API in either case). Local raster lookup — no network call, no measurable latency. */
export function getDemElevationMeters(dataDir: string, p: LonLat): number | null {
  const manifest = loadManifest(dataDir)
  if (!manifest) return null
  const tileIndex = findTile(manifest.tiles, p)
  if (tileIndex === -1) return null
  const meta = manifest.tiles[tileIndex]
  const demDir = path.join(DATA_DIR, dataDir, DEM_DIR_NAME)
  const tile = loadTile(dataDir, demDir, tileIndex, meta)
  const raw = bilinearSample(tile, meta, p)
  return raw / manifest.scale
}
