import 'dotenv/config'
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromArrayBuffer } from 'geotiff'
import { PARKS, type ParkConfig } from '../parks.js'
import { loadTrails, loadRoads } from '../data.js'
import type { DemManifest, DemTileMeta } from '../dem/manifest.js'
import { DEM_DIR_NAME, MANIFEST_FILE_NAME } from '../dem/manifest.js'

/**
 * Downloads a local elevation raster (from USGS's public 3DEP ImageServer) covering a park's
 * trail/road network, and converts it into this project's own compact tile format for fast local
 * reads at request time — see demElevation.ts for the reader. Once a park has a manifest.json
 * here, elevation.ts uses it instead of live per-point USGS EPQS lookups: zero network latency,
 * for any point, not just previously-visited trail segments.
 *
 * Usage: npx tsx src/scripts/fetchDem.ts <parkId> [parkId ...] | all
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')

const EXPORT_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
/** 1/3 arc-second ≈ 10m — USGS's national-baseline DEM resolution, same source EPQS itself serves. */
const ARC_SECONDS = 1 / 3
const PIXELS_PER_DEGREE = 3600 / ARC_SECONDS
/** Kept comfortably under the service's 8000px cap so a single request stays a reasonable transfer size. */
const MAX_TILE_PIXELS = 4000
/** Extra pixels requested beyond each tile's nominal cell, so bilinear interpolation near a tile
 * boundary always has real neighboring pixels rather than needing cross-tile lookups. */
const TILE_PADDING_PIXELS = 12
/**
 * Elevation stored as Int16 in whole meters. Originally SCALE=10 (decimeters), but that only
 * covers elevations up to 32767/10 = 3276.7m before silently wrapping to a large negative number
 * on write (plain Int16Array assignment truncates/wraps out-of-range values with no error) — several
 * of our parks have real terrain above that (Rainier 4392m, Longs Peak in Rocky Mountain 4346m,
 * the Whitney/High Sierra area in Inyo NF and Sequoia/Kings Canyon above 4400m), so any route
 * touching that terrain silently corrupted to wildly wrong elevation swings. 1m precision is far
 * more than the ~25m noise-filter threshold already applied downstream needs, and comfortably
 * covers anything on Earth (Everest is 8849m) at the same 2-byte-per-pixel storage cost.
 */
const SCALE = 1
// The 3DEP ImageServer is flaky under sustained use in two different ways: (1) genuinely
// transient 400/500/504s that succeed on an identical immediate retry, and (2) requests that
// reproducibly fail every time at one size but succeed once the same area is split into smaller
// pieces (observed on a Mount Rainier tile: an ~9M-pixel request failed 8/8 retries, a quarter-size
// sub-region of the exact same area succeeded first try) — some specific region+size combinations
// seem to be too expensive for the service to render, independent of transient load. Retries with
// backoff handle case (1); recursive quadrant-splitting (see fetchRasterResilient) handles (2).
const MAX_RETRIES = 4
const REQUEST_TIMEOUT_MS = 90000
/** Below this size, give up splitting further and let the retry loop's final failure propagate. */
const MIN_SPLIT_PIXELS = 400

function bboxFromNetwork(park: ParkConfig): [lonMin: number, lonMax: number, latMin: number, latMax: number] {
  const trails = loadTrails(park.dataDir)
  const roads = loadRoads(park.dataDir)
  let lonMin = Infinity
  let lonMax = -Infinity
  let latMin = Infinity
  let latMax = -Infinity
  for (const fc of [trails, roads]) {
    for (const feature of fc.features) {
      for (const [lon, lat] of feature.geometry.coordinates) {
        if (lon < lonMin) lonMin = lon
        if (lon > lonMax) lonMax = lon
        if (lat < latMin) latMin = lat
        if (lat > latMax) latMax = lat
      }
    }
  }
  // 5% padding so trails right at the network's bounding edge still have full interpolation coverage.
  const lonPad = (lonMax - lonMin) * 0.05
  const latPad = (latMax - latMin) * 0.05
  return [lonMin - lonPad, lonMax + lonPad, latMin - latPad, latMax + latPad]
}

interface TilePlan {
  index: number
  /** Nominal (non-overlapping) bbox this tile is authoritative for. */
  nominalBbox: [number, number, number, number]
  /** Padded bbox actually requested/stored, so edge interpolation has real neighbors. */
  requestBbox: [number, number, number, number]
  widthPx: number
  heightPx: number
}

function planTiles(bbox: [number, number, number, number]): TilePlan[] {
  const [lonMin, lonMax, latMin, latMax] = bbox
  const totalWidthPx = Math.max(1, Math.round((lonMax - lonMin) * PIXELS_PER_DEGREE))
  const totalHeightPx = Math.max(1, Math.round((latMax - latMin) * PIXELS_PER_DEGREE))
  const cols = Math.ceil(totalWidthPx / MAX_TILE_PIXELS)
  const rows = Math.ceil(totalHeightPx / MAX_TILE_PIXELS)

  const tiles: TilePlan[] = []
  let index = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const nomLonMin = lonMin + (col / cols) * (lonMax - lonMin)
      const nomLonMax = lonMin + ((col + 1) / cols) * (lonMax - lonMin)
      // Row 0 = northernmost band, matching how the stored raster's row 0 is the top (north).
      const nomLatMax = latMax - (row / rows) * (latMax - latMin)
      const nomLatMin = latMax - ((row + 1) / rows) * (latMax - latMin)

      const padLon = (TILE_PADDING_PIXELS / PIXELS_PER_DEGREE)
      const padLat = (TILE_PADDING_PIXELS / PIXELS_PER_DEGREE)
      const reqLonMin = Math.max(lonMin, nomLonMin - padLon)
      const reqLonMax = Math.min(lonMax, nomLonMax + padLon)
      const reqLatMin = Math.max(latMin, nomLatMin - padLat)
      const reqLatMax = Math.min(latMax, nomLatMax + padLat)

      const widthPx = Math.max(2, Math.round((reqLonMax - reqLonMin) * PIXELS_PER_DEGREE))
      const heightPx = Math.max(2, Math.round((reqLatMax - reqLatMin) * PIXELS_PER_DEGREE))

      tiles.push({
        index: index++,
        nominalBbox: [nomLonMin, nomLonMax, nomLatMin, nomLatMax],
        requestBbox: [reqLonMin, reqLonMax, reqLatMin, reqLatMax],
        widthPx,
        heightPx,
      })
    }
  }
  return tiles
}

async function fetchRasterDirect(requestBbox: [number, number, number, number], widthPx: number, heightPx: number): Promise<Float32Array> {
  const [lonMin, lonMax, latMin, latMax] = requestBbox
  const params = new URLSearchParams({
    bbox: `${lonMin},${latMin},${lonMax},${latMax}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${widthPx},${heightPx}`,
    format: 'tiff',
    pixelType: 'F32',
    noData: '-9999',
    interpolation: 'RSP_BilinearInterpolation',
    // Requesting f=image (a direct binary response) 500s consistently for some size/bbox
    // combinations, seemingly independent of image size — f=json against the identical params
    // reliably succeeds and returns a hosted href for the same TIFF, so that's used instead.
    f: 'json',
  })
  const url = `${EXPORT_URL}?${params.toString()}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const jobRes = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!jobRes.ok) throw new Error(`3DEP ImageServer returned ${jobRes.status}`)
      const job = (await jobRes.json()) as { href?: string; error?: { message?: string } }
      if (!job.href) throw new Error(`3DEP ImageServer returned no href: ${job.error?.message ?? JSON.stringify(job)}`)

      const imgRes = await fetch(job.href, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!imgRes.ok) throw new Error(`3DEP tiff download returned ${imgRes.status}`)
      const buf = await imgRes.arrayBuffer()
      const tiff = await fromArrayBuffer(buf)
      const image = await tiff.getImage()
      const rasters = await image.readRasters()
      return rasters[0] as unknown as Float32Array
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      const backoffMs = Math.min(60000, 2000 * 2 ** attempt)
      console.log(`[dem]   retrying after ${(backoffMs / 1000).toFixed(0)}s (attempt ${attempt + 1}/${MAX_RETRIES}) — ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, backoffMs))
    }
  }
  throw new Error('unreachable')
}

/**
 * Fetches a raster region, falling back to recursive 2x2 quadrant-splitting if the region
 * consistently fails at full size (see the flakiness note above `MAX_RETRIES`). Quadrants are
 * split on exact pixel boundaries and reassembled into one Float32Array matching the original
 * width/height, so callers never need to know a region was actually fetched in pieces.
 */
async function fetchRasterResilient(
  requestBbox: [number, number, number, number],
  widthPx: number,
  heightPx: number,
  depth = 0,
): Promise<Float32Array> {
  try {
    return await fetchRasterDirect(requestBbox, widthPx, heightPx)
  } catch (err) {
    if (widthPx <= MIN_SPLIT_PIXELS || heightPx <= MIN_SPLIT_PIXELS) throw err
    console.log(`[dem]   ${widthPx}x${heightPx}px region failed after retries, splitting into quadrants and retrying each...`)

    const [lonMin, lonMax, latMin, latMax] = requestBbox
    const colSplit = Math.ceil(widthPx / 2)
    const rowSplit = Math.ceil(heightPx / 2)
    const lonSplit = lonMin + (colSplit / widthPx) * (lonMax - lonMin)
    const latSplit = latMax - (rowSplit / heightPx) * (latMax - latMin) // row 0 = north, so splitting rows moves down from latMax

    const quadrants = [
      { bbox: [lonMin, lonSplit, latSplit, latMax] as [number, number, number, number], w: colSplit, h: rowSplit, colOffset: 0, rowOffset: 0 },
      { bbox: [lonSplit, lonMax, latSplit, latMax] as [number, number, number, number], w: widthPx - colSplit, h: rowSplit, colOffset: colSplit, rowOffset: 0 },
      { bbox: [lonMin, lonSplit, latMin, latSplit] as [number, number, number, number], w: colSplit, h: heightPx - rowSplit, colOffset: 0, rowOffset: rowSplit },
      {
        bbox: [lonSplit, lonMax, latMin, latSplit] as [number, number, number, number],
        w: widthPx - colSplit,
        h: heightPx - rowSplit,
        colOffset: colSplit,
        rowOffset: rowSplit,
      },
    ]

    const assembled = new Float32Array(widthPx * heightPx)
    for (const q of quadrants) {
      const data = await fetchRasterResilient(q.bbox, q.w, q.h, depth + 1)
      for (let r = 0; r < q.h; r++) {
        const srcStart = r * q.w
        const destStart = (q.rowOffset + r) * widthPx + q.colOffset
        assembled.set(data.subarray(srcStart, srcStart + q.w), destStart)
      }
    }
    return assembled
  }
}

async function fetchParkDem(park: ParkConfig) {
  const demDir = path.join(DATA_DIR, park.dataDir, DEM_DIR_NAME)
  const manifestPath = path.join(demDir, MANIFEST_FILE_NAME)
  if (existsSync(manifestPath)) {
    console.log(`[dem] ${park.id}: already has a manifest, skipping (delete ${manifestPath} to redo)`)
    return
  }
  mkdirSync(demDir, { recursive: true })

  console.log(`[dem] ${park.id}: computing bbox from trail/road network...`)
  const bbox = bboxFromNetwork(park)
  const tiles = planTiles(bbox)
  console.log(
    `[dem] ${park.id}: bbox [${bbox.map((n) => n.toFixed(3)).join(', ')}], ${tiles.length} tile(s) at ~${(ARC_SECONDS * 30.87).toFixed(1)}m/px`,
  )

  const tileMetas: DemTileMeta[] = []
  const startedAt = Date.now()

  for (const tile of tiles) {
    const fileName = `tile-${tile.index}.bin`
    const filePath = path.join(demDir, fileName)
    const expectedBytes = tile.widthPx * tile.heightPx * 2

    // Resumable per tile: if a previous run for this park got partway through before failing (no
    // manifest gets written until every tile succeeds), already-fetched tiles are reused instead of
    // re-downloaded — matters most for the largest parks, tens of tiles each a real network transfer.
    if (existsSync(filePath) && statSync(filePath).size === expectedBytes) {
      console.log(`[dem] ${park.id}: tile ${tile.index + 1}/${tiles.length} already on disk, reusing`)
      tileMetas.push({
        file: fileName,
        nominalBbox: tile.nominalBbox,
        bbox: tile.requestBbox,
        width: tile.widthPx,
        height: tile.heightPx,
      })
      continue
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0)
    console.log(
      `[dem] ${park.id}: tile ${tile.index + 1}/${tiles.length} (${tile.widthPx}x${tile.heightPx}px)... [${elapsedSec}s elapsed]`,
    )
    const raster = await fetchRasterResilient(tile.requestBbox, tile.widthPx, tile.heightPx)

    const int16 = new Int16Array(raster.length)
    for (let i = 0; i < raster.length; i++) {
      const v = raster[i]
      // USGS uses a large negative sentinel for no-data (ocean/outside coverage); clamp rather than
      // let it corrupt gain/loss math downstream — shouldn't occur within a park's own trail bbox.
      int16[i] = !Number.isFinite(v) || v < -1000 ? 0 : Math.round(v * SCALE)
    }

    writeFileSync(filePath, Buffer.from(int16.buffer))
    tileMetas.push({
      file: fileName,
      nominalBbox: tile.nominalBbox,
      bbox: tile.requestBbox,
      width: tile.widthPx,
      height: tile.heightPx,
    })
  }

  const manifest: DemManifest = { arcSeconds: ARC_SECONDS, scale: SCALE, tiles: tileMetas }
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const totalMB = tileMetas.reduce((sum, t) => sum + (t.width * t.height * 2) / (1024 * 1024), 0)
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0)
  console.log(`[dem] ${park.id}: done in ${elapsedSec}s — ${tiles.length} tile(s), ${totalMB.toFixed(1)} MB on disk`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: npx tsx src/scripts/fetchDem.ts <parkId> [parkId ...] | all')
    process.exitCode = 1
    return
  }
  const parkIds = args[0] === 'all' ? PARKS.map((p) => p.id) : args

  for (const parkId of parkIds) {
    const park = PARKS.find((p) => p.id === parkId)
    if (!park) {
      console.error(`[dem] Unknown park "${parkId}". Known parks: ${PARKS.map((p) => p.id).join(', ')}`)
      continue
    }
    try {
      await fetchParkDem(park)
    } catch (err) {
      console.error(`[dem] ${park.id}: FAILED —`, err)
    }
  }
  console.log('\n[dem] all requested parks complete.')
}

main()
