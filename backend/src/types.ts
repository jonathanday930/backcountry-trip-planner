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
  properties: { name: string; osm_way_id?: number }
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
