export interface Campsite {
  id: string
  name: string
  lat: number
  lon: number
  type: string
  context?: string
  /** Recreation.gov "Starting Area" name(s) (division.district) this point is available from. */
  startingAreas?: string[]
  closed?: boolean
  /** Date we scraped/verified the source still listed this as closed, not when it actually closed (Recreation.gov doesn't expose that). */
  closedAsOf?: string
}

export interface TrailFeature {
  type: 'Feature'
  /** `kind` distinguishes a hiking trail from a walkable road segment (e.g. a gravel road leading to a trailhead); both are equally valid for routing. */
  properties: {
    name: string
    osm_way_id?: number
    kind?: 'trail' | 'road'
    /** Precomputed once at boot (see `parkNetwork.ts`) so the frontend never has to run its own
     * point-in-polygon test against the park boundary on every re-render — only set for roads,
     * and only when the park has a `boundary.geojson`; used purely for map styling, not routing. */
    insideBoundary?: boolean
  }
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

export interface TrailsGeoJson {
  type: 'FeatureCollection'
  features: TrailFeature[]
}

export interface ZoneFeature {
  type: 'Feature'
  /** Matches a campsite's `name` in campsites.json, so the frontend can pair a zone's shaded area with its marker/popup. */
  properties: { name: string }
  geometry: { type: 'Polygon'; coordinates: [number, number][][] }
}

export interface ZonesGeoJson {
  type: 'FeatureCollection'
  features: ZoneFeature[]
}

export interface BoundaryFeature {
  type: 'Feature'
  properties: { name: string }
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
}

/** A park/forest's own outer boundary (distinct from `zones`, which are internal permit-area
 * subdivisions), used only to decide how to render a road on the map — every road is equally
 * routable regardless of which side of this boundary it falls on. */
export interface BoundaryGeoJson {
  type: 'FeatureCollection'
  features: BoundaryFeature[]
}

export interface RouteResult {
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
  routeGeoJson: { type: 'LineString'; coordinates: [number, number][] }
}
