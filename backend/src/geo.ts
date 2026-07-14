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
