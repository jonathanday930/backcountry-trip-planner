export interface DemTileMeta {
  file: string
  /** Nominal (non-overlapping) coverage of this tile — used to pick which tile a point belongs to. */
  nominalBbox: [lonMin: number, lonMax: number, latMin: number, latMax: number]
  /** Actual stored raster extent, padded a few pixels beyond nominalBbox so bilinear interpolation
   * near a tile edge always has real neighboring pixels rather than needing cross-tile lookups. */
  bbox: [lonMin: number, lonMax: number, latMin: number, latMax: number]
  width: number
  height: number
}

export interface DemManifest {
  /** Nominal resolution in arc-seconds (e.g. 1/3 arc-second ≈ 10m) — informational only. */
  arcSeconds: number
  /** Elevation values are stored as Int16 in units of 1/scale meters (scale=10 -> decimeters). */
  scale: number
  tiles: DemTileMeta[]
}

export const DEM_DIR_NAME = 'dem'
export const MANIFEST_FILE_NAME = 'manifest.json'
