export interface Campsite {
  id: string
  name: string
  lat: number
  lon: number
  type: string
  context?: string
}

export interface TrailFeature {
  type: 'Feature'
  /** `kind` distinguishes a hiking trail from a walkable road segment (e.g. a gravel road leading to a trailhead); both are equally valid for routing. */
  properties: { name: string; osm_way_id?: number; kind?: 'trail' | 'road' }
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

export interface TrailsGeoJson {
  type: 'FeatureCollection'
  features: TrailFeature[]
}

export interface RouteResult {
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
  routeGeoJson: { type: 'LineString'; coordinates: [number, number][] }
}
