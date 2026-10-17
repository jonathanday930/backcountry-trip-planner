export interface LonLat {
  lon: number
  lat: number
}


const EARTH_RADIUS_M = 6371000

export function haversineMeters(a: LonLat, b: LonLat): number {
  const p1 = (a.lat * Math.PI) / 180
  const p2 = (b.lat * Math.PI) / 180
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180
  const sinDPhi = Math.sin(dPhi / 2)
  const sinDLambda = Math.sin(dLambda / 2)
  const h = sinDPhi * sinDPhi + Math.cos(p1) * Math.cos(p2) * sinDLambda * sinDLambda
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/**
 * Projects point p onto the segment ab (treating lon/lat as locally planar,
 * which is accurate enough at the scale of a single trail segment) and
 * returns the projected point, the fractional position t in [0,1] along ab,
 * and the great-circle distance from p to the projection.
 */
export function projectPointOntoSegment(p: LonLat, a: LonLat, b: LonLat): { point: LonLat; t: number; distanceMeters: number } {
  const latScale = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
  const ax = a.lon * latScale
  const ay = a.lat
  const bx = b.lon * latScale
  const by = b.lat
  const px = p.lon * latScale
  const py = p.lat

  const abx = bx - ax
  const aby = by - ay
  const lenSq = abx * abx + aby * aby

  let t = lenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lenSq
  t = Math.max(0, Math.min(1, t))

  const point: LonLat = { lon: a.lon + t * (b.lon - a.lon), lat: a.lat + t * (b.lat - a.lat) }
  return { point, t, distanceMeters: haversineMeters(p, point) }
}

type Ring = number[][]
type PolygonCoords = Ring[]
type MultiPolygonCoords = PolygonCoords[]

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function pointInPolygon(lon: number, lat: number, polygon: PolygonCoords): boolean {
  if (polygon.length === 0 || !pointInRing(lon, lat, polygon[0])) return false
  // Any remaining ring is a hole; being inside one excludes the point from the polygon.
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) return false
  }
  return true
}

/** Ray-casting point-in-polygon test (holes respected) against a GeoJSON Polygon or MultiPolygon geometry. */
export function pointInGeometry(
  lon: number,
  lat: number,
  geometry: { type: 'Polygon'; coordinates: PolygonCoords } | { type: 'MultiPolygon'; coordinates: MultiPolygonCoords },
): boolean {
  if (geometry.type === 'Polygon') return pointInPolygon(lon, lat, geometry.coordinates)
  return geometry.coordinates.some((polygon) => pointInPolygon(lon, lat, polygon))
}

function perpendicularDistanceMeters(p: LonLat, a: LonLat, b: LonLat): number {
  if (a.lon === b.lon && a.lat === b.lat) return haversineMeters(p, a)
  return projectPointOntoSegment(p, a, b).distanceMeters
}

/**
 * Douglas-Peucker polyline simplification. Used to cut down park boundary rings (which can carry
 * tens of thousands of vertices straight from NPS source data — Grand Canyon's full-permit-system
 * boundary has 44k) before running them through `pointInGeometry` at server boot: that check only
 * ever decides a road's map *styling* (solid vs. dashed, see `parkNetwork.ts`), not routing, so a
 * ~100m simplification tolerance is invisible in practice but turns an 8+ second ray-cast pass over
 * every road segment into a sub-100ms one.
 */
export function simplifyRing(ring: Ring, toleranceMeters: number): Ring {
  if (ring.length <= 3) return ring
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    if (end <= start + 1) continue
    const a: LonLat = { lon: ring[start][0], lat: ring[start][1] }
    const b: LonLat = { lon: ring[end][0], lat: ring[end][1] }
    let maxDist = -1
    let maxIndex = -1
    for (let i = start + 1; i < end; i++) {
      const p: LonLat = { lon: ring[i][0], lat: ring[i][1] }
      const dist = perpendicularDistanceMeters(p, a, b)
      if (dist > maxDist) {
        maxDist = dist
        maxIndex = i
      }
    }
    if (maxDist > toleranceMeters) {
      keep[maxIndex] = 1
      stack.push([start, maxIndex], [maxIndex, end])
    }
  }
  const result: Ring = []
  for (let i = 0; i < ring.length; i++) if (keep[i]) result.push(ring[i])
  return result
}

/** Interpolates points along a polyline at roughly the given spacing (meters), always including the endpoints. */
export function densifyPolyline(points: LonLat[], spacingMeters: number): LonLat[] {
  if (points.length < 2) return points.slice()

  const result: LonLat[] = [points[0]]
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const segLen = haversineMeters(a, b)
    const steps = Math.max(1, Math.round(segLen / spacingMeters))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      result.push({ lon: a.lon + t * (b.lon - a.lon), lat: a.lat + t * (b.lat - a.lat) })
    }
  }
  return result
}
