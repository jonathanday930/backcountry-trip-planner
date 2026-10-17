import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getOrLoadParkState, resolveStopCoordinate } from '../parkState.js'
import { buildRouteSubgraph, UnroutableStopError, type ResolvedStop } from '../routeSubgraph.js'
import { computeRouteElevation } from '../elevation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')

const METERS_TO_MILES = 1 / 1609.344
const METERS_TO_FEET = 3.28084

interface KnownRouteRaw {
  id: string
  name: string
  stops: string[]
  /** Optional geometry corridor. When present, this is used for routing totals while `stops`
   * remains the complete ordered list of campsite choices shown to the user. */
  routeStops?: string[]
  typicalNights: number
  notes: string
}

export interface KnownRouteLeg {
  from: string
  to: string
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
}

export interface KnownRoute {
  id: string
  name: string
  typicalNights: number
  notes: string
  stops: string[]
  /** All overnight options encountered along the corridor, including sites too close together
   * to be useful as separate routing waypoints. */
  campsiteStops: string[]
  campsites: { id: string; name: string; type: string; closed?: boolean }[]
  totalDistanceMiles: number
  totalElevationGainFt: number
  totalElevationLossFt: number
  legs: KnownRouteLeg[]
}

export interface KnownRoutesResult {
  parkId: string
  routes: KnownRoute[]
  note?: string
}

function loadRawRoutes(dataDir: string): KnownRouteRaw[] | null {
  const filePath = path.join(DATA_DIR, dataDir, 'known-routes.json')
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

/** Computes each curated route's real mileage/elevation live, via the same `buildRouteSubgraph`
 * `/api/route` itself uses — the stored JSON only ever names real stop ids, never a baked-in
 * distance, so these numbers can never drift out of sync with what the app would show for the
 * same stops. */
export async function getKnownRoutes(parkId: string): Promise<KnownRoutesResult> {
  const state = getOrLoadParkState(parkId)
  if (!state) throw new Error(`Unknown park "${parkId}"`)

  const raw = loadRawRoutes(state.dataDir)
  if (!raw || raw.length === 0) {
    return { parkId, routes: [], note: 'No curated known routes for this park yet — fall back to general knowledge, and say so.' }
  }

  const routes: KnownRoute[] = []
  for (const r of raw) {
    const routeStops = r.routeStops ?? r.stops
    const resolved: ResolvedStop[] = routeStops.map((token) => {
      const s = resolveStopCoordinate(state.campsites, token)
      if (!s) throw new Error(`known-routes.json for ${parkId} references unknown stop "${token}" (route ${r.id})`)
      return s
    })

    const { legs: legOutcomes } = buildRouteSubgraph(state.trails, state.campsites, parkId, resolved)
    const legs: KnownRouteLeg[] = []
    let totalDistanceMiles = 0
    let totalElevationGainFt = 0
    let totalElevationLossFt = 0

    for (let i = 0; i < legOutcomes.length; i++) {
      const outcome = legOutcomes[i]
      const from = routeStops[i]
      const to = routeStops[i + 1]
      if (outcome.kind === 'no-route') throw new UnroutableStopError(`known route "${r.id}" has no route between "${from}" and "${to}"`)
      if (outcome.kind === 'same-node') {
        legs.push({ from, to, distanceMiles: 0, elevationGainFt: 0, elevationLossFt: 0 })
        continue
      }
      const { gainMeters, lossMeters } = await computeRouteElevation(state.dataDir, outcome.path.edges)
      const distanceMiles = outcome.path.totalDistanceMeters * METERS_TO_MILES
      const elevationGainFt = gainMeters * METERS_TO_FEET
      const elevationLossFt = lossMeters * METERS_TO_FEET
      legs.push({ from, to, distanceMiles, elevationGainFt, elevationLossFt })
      totalDistanceMiles += distanceMiles
      totalElevationGainFt += elevationGainFt
      totalElevationLossFt += elevationLossFt
    }

    routes.push({
      id: r.id,
      name: r.name,
      typicalNights: r.typicalNights,
      notes: r.notes,
      stops: routeStops,
      campsiteStops: r.stops.filter((token) => {
        const site = state.campsites.find((candidate) => candidate.id === token)
        return site != null && site.type !== 'trailhead'
      }),
      campsites: r.stops.flatMap((token) => {
        const site = state.campsites.find((candidate) => candidate.id === token)
        return site && site.type !== 'trailhead'
          ? [{ id: site.id, name: site.name, type: site.type, ...(site.closed ? { closed: true } : {}) }]
          : []
      }),
      totalDistanceMiles,
      totalElevationGainFt,
      totalElevationLossFt,
      legs,
    })
  }

  return { parkId, routes }
}
