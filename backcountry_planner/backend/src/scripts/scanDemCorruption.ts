import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARKS } from '../parks.js'
import { DEM_DIR_NAME, MANIFEST_FILE_NAME, type DemManifest } from '../dem/manifest.js'

/**
 * Sanity-checks every fetched park's DEM tiles for Int16 wraparound corruption — catches the class
 * of bug where an elevation value exceeds what the manifest's `scale` can represent in a signed
 * 16-bit int and silently wraps to a large negative number on write (e.g. scale=10/decimeters could
 * only represent up to 3276.7m before wrapping; several parks have real terrain above that). No
 * real terrain in any of our parks is anywhere near IMPLAUSIBLE_ELEVATION_METERS, so any pixel that
 * low is corruption, not a legitimate reading.
 *
 * Usage: npx tsx src/scripts/scanDemCorruption.ts
 */
const IMPLAUSIBLE_ELEVATION_METERS = -500

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')

for (const park of PARKS) {
  const demDir = path.join(DATA_DIR, park.dataDir, DEM_DIR_NAME)
  let manifest: DemManifest
  try {
    manifest = JSON.parse(readFileSync(path.join(demDir, MANIFEST_FILE_NAME), 'utf-8'))
  } catch {
    console.log(`${park.id}: no DEM manifest, skipping`)
    continue
  }

  let worstMeters = Infinity
  let corruptedPixels = 0
  let totalPixels = 0
  for (const tile of manifest.tiles) {
    const buf = readFileSync(path.join(demDir, tile.file))
    const data = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
    totalPixels += data.length
    for (let i = 0; i < data.length; i++) {
      const meters = data[i] / manifest.scale
      if (meters < worstMeters) worstMeters = meters
      if (meters < IMPLAUSIBLE_ELEVATION_METERS) corruptedPixels++
    }
  }

  const status = corruptedPixels > 0 ? 'CORRUPTED' : 'clean'
  console.log(
    `${park.id}: ${status} — worst value ${worstMeters.toFixed(1)}m, ${corruptedPixels}/${totalPixels} pixels implausible (scale=${manifest.scale})`,
  )
}
