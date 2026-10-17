import type { Campsite, TrailsGeoJson } from './types.js'
import { buildRouteSubgraph, UnroutableStopError, type ResolvedStop } from './routeSubgraph.js'
import { resolveStopCoordinate } from './parkState.js'
import { computeRouteElevation } from './elevation.js'

const METERS_TO_MILES = 1 / 1609.344
const METERS_TO_FEET = 3.28084

export interface LegStats {
  from: string
  to: string
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
}

export interface ItinerarySplit {
  nights: number
  /** Stop tokens actually camped at, in order (excludes the start; includes the final stop as
   * the exit-day destination, not a camp). */
  campedAt: string[]
  dailyLegs: LegStats[]
  worstDayMiles: number
}

export interface SolveItineraryParams {
  parkId: string
  dataDir: string
  campsites: Campsite[]
  trails: TrailsGeoJson
  /** Ordered corridor of real stop ids/tokens, start first, exit last — this tool does not choose
   * or reorder stops, only how to split an already-chosen corridor across nights. */
  stops: string[]
  maxDailyMiles: number
  /** Night counts to evaluate, e.g. [3] or [3, 4] — each gets the best (most balanced) split that
   * respects `maxDailyMiles`, or a feasibility explanation if none exists. */
  nights: number[]
}

export interface NightsResult {
  nights: number
  feasible: boolean
  split?: ItinerarySplit
  /** Set when `feasible` is false: the best worst-day mileage achievable at this night count with
   * no daily cap at all — tells the caller whether more nights or a looser cap is what's needed. */
  bestPossibleWorstDayMiles?: number
}

export interface SolveItineraryResult {
  /** Real pairwise distance/elevation between every consecutive stop in the corridor, independent
   * of any split — useful context for the model even when a requested night count is infeasible. */
  legStats: LegStats[]
  results: NightsResult[]
}

const INFEASIBLE = Number.POSITIVE_INFINITY

/** Given cumulative one-way distances (miles) from the corridor's start, and a hard per-day cap,
 * finds the min-max-balanced way to reach the final stop using exactly `targetNights` intermediate
 * camps. `capMiles: null` drops the per-day cap entirely (used to report the best achievable worst
 * day when the capped version is infeasible). Returns the achieved worst-day mileage and the
 * chosen intermediate stop indices, or null if truly unreachable (only possible with a cap that's
 * smaller than the corridor's own longest single required leg). */
function bestSplitForNightCount(
  cumMiles: number[],
  targetNights: number,
  capMiles: number | null,
): { worstDayMiles: number; campIndices: number[] } | null {
  const n = cumMiles.length // number of stops, indices 0..n-1
  const maxK = targetNights
  // dp[j][k] = best (min possible) worst-day mileage to reach stop j using exactly k intermediate camps
  const dp: number[][] = Array.from({ length: n }, () => Array(maxK + 1).fill(INFEASIBLE))
  const pred: (number | null)[][] = Array.from({ length: n }, () => Array(maxK + 1).fill(null))
  dp[0][0] = 0

  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      const legMiles = cumMiles[j] - cumMiles[i]
      if (capMiles !== null && legMiles > capMiles) continue
      const kOffset = i === 0 ? 0 : 1
      for (let k = kOffset; k <= maxK; k++) {
        const prevK = k - kOffset
        if (dp[i][prevK] === INFEASIBLE) continue
        const candidate = Math.max(dp[i][prevK], legMiles)
        if (candidate < dp[j][k]) {
          dp[j][k] = candidate
          pred[j][k] = i
        }
      }
    }
  }

  const finalMiles = dp[n - 1][maxK]
  if (finalMiles === INFEASIBLE) return null

  const campIndices: number[] = []
  let j = n - 1
  let k = maxK
  while (j !== 0) {
    const i = pred[j][k]
    if (i === null) break // shouldn't happen if finalMiles was finite, but stay defensive
    if (i !== 0) campIndices.unshift(i)
    k -= i === 0 ? 0 : 1
    j = i
  }
  return { worstDayMiles: finalMiles, campIndices }
}

export async function solveItinerary(params: SolveItineraryParams): Promise<SolveItineraryResult> {
  const { parkId, dataDir, campsites, trails, stops, maxDailyMiles, nights } = params
  if (stops.length < 2) throw new Error('Need at least a start and an end stop')

  const resolved: ResolvedStop[] = stops.map((token) => {
    const r = resolveStopCoordinate(campsites, token)
    if (!r) throw new Error(`Unknown stop "${token}"`)
    return r
  })

  const { legs } = buildRouteSubgraph(trails, campsites, parkId, resolved)

  // Real distance/elevation for every consecutive pair — computed once, reused both as the
  // transparency output and as the DP's input, so the DP can never disagree with what /api/route
  // would show for the same stop sequence.
  const legStats: LegStats[] = []
  const cumMiles: number[] = [0]
  for (let i = 0; i < legs.length; i++) {
    const outcome = legs[i]
    const from = stops[i]
    const to = stops[i + 1]
    if (outcome.kind === 'no-route') {
      throw new UnroutableStopError(`No route found between "${from}" and "${to}"`)
    }
    if (outcome.kind === 'same-node') {
      legStats.push({ from, to, distanceMiles: 0, elevationGainFt: 0, elevationLossFt: 0 })
      cumMiles.push(cumMiles[i])
      continue
    }
    const { gainMeters, lossMeters } = await computeRouteElevation(dataDir, outcome.path.edges)
    const distanceMiles = outcome.path.totalDistanceMeters * METERS_TO_MILES
    legStats.push({
      from,
      to,
      distanceMiles,
      elevationGainFt: gainMeters * METERS_TO_FEET,
      elevationLossFt: lossMeters * METERS_TO_FEET,
    })
    cumMiles.push(cumMiles[i] + distanceMiles)
  }

  const results: NightsResult[] = nights.map((targetNights) => {
    if (targetNights < 0 || targetNights > stops.length - 2) {
      return { nights: targetNights, feasible: false }
    }
    const capped = bestSplitForNightCount(cumMiles, targetNights, maxDailyMiles)
    if (capped) {
      const campIndices = capped.campIndices
      const dailyLegs: LegStats[] = []
      let prevIdx = 0
      for (const idx of [...campIndices, stops.length - 1]) {
        // Recombine the precomputed per-consecutive-pair legStats into this split's actual daily
        // legs (which may span multiple corridor stops per day).
        let distanceMiles = 0
        let elevationGainFt = 0
        let elevationLossFt = 0
        for (let i = prevIdx; i < idx; i++) {
          distanceMiles += legStats[i].distanceMiles
          elevationGainFt += legStats[i].elevationGainFt
          elevationLossFt += legStats[i].elevationLossFt
        }
        dailyLegs.push({ from: stops[prevIdx], to: stops[idx], distanceMiles, elevationGainFt, elevationLossFt })
        prevIdx = idx
      }
      return {
        nights: targetNights,
        feasible: true,
        split: { nights: targetNights, campedAt: campIndices.map((i) => stops[i]).concat(stops[stops.length - 1]), dailyLegs, worstDayMiles: capped.worstDayMiles },
      }
    }
    const uncapped = bestSplitForNightCount(cumMiles, targetNights, null)
    return { nights: targetNights, feasible: false, bestPossibleWorstDayMiles: uncapped?.worstDayMiles }
  })

  return { legStats, results }
}
