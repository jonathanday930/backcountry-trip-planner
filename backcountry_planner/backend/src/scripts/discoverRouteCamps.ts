import { getOrLoadParkState, resolveStopCoordinate } from '../parkState.js'
import { buildRouteSubgraph, type ResolvedStop } from '../routeSubgraph.js'
import { haversineMeters, projectPointOntoSegment, type LonLat } from '../geo.js'

const [, , parkId, rawStops, rawThreshold] = process.argv
if (!parkId || !rawStops) {
  console.error('Usage: npx tsx src/scripts/discoverRouteCamps.ts <park-id> <stop-id|stop-id|...> [max-off-route-meters]')
  process.exit(1)
}

const state = getOrLoadParkState(parkId)
if (!state) throw new Error(`Unknown park "${parkId}"`)

const stopIds = rawStops.split('|')
const stops: ResolvedStop[] = stopIds.map((id) => {
  const stop = resolveStopCoordinate(state.campsites, id)
  if (!stop) throw new Error(`Unknown stop "${id}"`)
  return stop
})
const maxOffRouteMeters = Number(rawThreshold ?? 500)
const result = buildRouteSubgraph(state.trails, state.campsites, parkId, stops)

const routeSegments: { a: LonLat; b: LonLat; startMeters: number; lengthMeters: number }[] = []
let routeLengthMeters = 0
for (const leg of result.legs) {
  if (leg.kind !== 'path') continue
  for (const edge of leg.path.edges) {
    for (let i = 0; i < edge.polyline.length - 1; i++) {
      const a = edge.polyline[i]
      const b = edge.polyline[i + 1]
      const lengthMeters = haversineMeters(a, b)
      routeSegments.push({ a, b, startMeters: routeLengthMeters, lengthMeters })
      routeLengthMeters += lengthMeters
    }
  }
}

const matches = state.campsites
  .filter((site) => site.type !== 'trailhead')
  .map((site) => {
    let best = { distanceMeters: Number.POSITIVE_INFINITY, routeMeters: 0 }
    for (const segment of routeSegments) {
      const projection = projectPointOntoSegment(site, segment.a, segment.b)
      if (projection.distanceMeters < best.distanceMeters) {
        best = {
          distanceMeters: projection.distanceMeters,
          routeMeters: segment.startMeters + projection.t * segment.lengthMeters,
        }
      }
    }
    return { site, ...best }
  })
  .filter((match) => match.distanceMeters <= maxOffRouteMeters)
  .sort((a, b) => a.routeMeters - b.routeMeters)

console.log(JSON.stringify({
  parkId,
  anchors: stopIds,
  routeMiles: routeLengthMeters / 1609.344,
  maxOffRouteMeters,
  campsites: matches.map(({ site, routeMeters, distanceMeters }) => ({
    id: site.id,
    name: site.name,
    type: site.type,
    mile: routeMeters / 1609.344,
    offRouteMeters: distanceMeters,
  })),
}, null, 2))
