import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Campsite, TrailsGeoJson } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

export function loadCampsites(parkDataDir: string): Campsite[] {
  const raw = readFileSync(path.join(DATA_DIR, parkDataDir, 'campsites.json'), 'utf-8')
  return JSON.parse(raw)
}

export function loadTrails(parkDataDir: string): TrailsGeoJson {
  const raw = readFileSync(path.join(DATA_DIR, parkDataDir, 'trails.geojson'), 'utf-8')
  return JSON.parse(raw)
}
