import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { BoundaryGeoJson, Campsite, TrailsGeoJson, ZonesGeoJson } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

export function loadCampsites(parkDataDir: string): Campsite[] {
  const raw = readFileSync(path.join(DATA_DIR, parkDataDir, 'campsites.json'), 'utf-8')
  const all: (Campsite & { lat: number | null; lon: number | null })[] = JSON.parse(raw)
  // Zone-based permit systems (e.g. Shenandoah, Grand Teton) can have records with no
  // lat/lon yet, pending a zone-polygon/overlay fill-in step — not routable or plottable
  // until then, so exclude rather than feeding null coordinates into graph building.
  return all.filter((c) => c.lat != null && c.lon != null)
}

export function loadTrails(parkDataDir: string): TrailsGeoJson {
  const raw = readFileSync(path.join(DATA_DIR, parkDataDir, 'trails.geojson'), 'utf-8')
  return JSON.parse(raw)
}

/** Roads a hiker can walk to reach or connect trail segments (e.g. an unpaved access road to a trailhead). */
export function loadRoads(parkDataDir: string): TrailsGeoJson {
  const raw = readFileSync(path.join(DATA_DIR, parkDataDir, 'roads.geojson'), 'utf-8')
  return JSON.parse(raw)
}

/** Backcountry zone/permit-area boundaries (e.g. at-large camping areas), for map shading. Optional — not every park has these mapped. */
export function loadZones(parkDataDir: string): ZonesGeoJson {
  const zonesPath = path.join(DATA_DIR, parkDataDir, 'zones.geojson')
  if (!existsSync(zonesPath)) return { type: 'FeatureCollection', features: [] }
  const raw = readFileSync(zonesPath, 'utf-8')
  return JSON.parse(raw)
}

/** The park/forest's own outer boundary, fetched by `scripts/fetch-park-boundary.ts`. Optional —
 * not every park has this fetched yet; parks without it fall back to styling all roads as if
 * they were inside the park. */
export function loadBoundary(parkDataDir: string): BoundaryGeoJson {
  const boundaryPath = path.join(DATA_DIR, parkDataDir, 'boundary.geojson')
  if (!existsSync(boundaryPath)) return { type: 'FeatureCollection', features: [] }
  const raw = readFileSync(boundaryPath, 'utf-8')
  return JSON.parse(raw)
}
