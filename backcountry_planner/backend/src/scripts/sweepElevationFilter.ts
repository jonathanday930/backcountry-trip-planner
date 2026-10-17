/**
 * Elevation-noise-filter tuning tool. Two modes, see testing/README.md's "Tuning the elevation
 * filter" section for when to reach for which:
 *
 * Park-wide sweep — find a single (smoothWindow, threshold) for PARK_FILTER_CONFIG, scored
 * against every already-scraped Komoot leg for that park (not just the failing ones):
 *   npx tsx src/scripts/sweepElevationFilter.ts --park <parkId>
 *
 * Corridor sweep — find a (smoothWindow, threshold) for ONE specific leg, plus the tight
 * geographic bbox CORRIDOR_FILTER_CONFIG would need to target just that leg, plus a check for
 * how much that bbox would "leak" into the park's other legs:
 *   npx tsx src/scripts/sweepElevationFilter.ts --park <parkId> --route "<route name>" --leg <0-based index>
 *
 * Both modes require testing/komoot-results.json to already have Komoot data for the park (run
 * testing/komoot-lookup.mjs first) and read testing/test-routes.json for the leg definitions.
 * Run from backend/.
 */
import { readFileSync } from 'node:fs'
import { loadParkNetwork } from '../parkNetwork.js'
import { shortestPath, attachPointToNetwork, type TrailGraph, type GraphEdge } from '../graph.js'
import { PARKS } from '../parks.js'
import { densifyPolyline, type LonLat } from '../geo.js'
import { getDemElevationMeters, hasDem } from '../demElevation.js'

const SAMPLE_SPACING_METERS = 50
const FLOOR_FT = 164 // 50m — matches testing/summarize-report.mjs's noise floor
const QUALIFY_PCT = 10
const QUALIFY_FT = 125 // matches the "worth fixing" bar used throughout testing/README.md

function movingAverage(values: number[], windowRadius: number): number[] {
  if (windowRadius <= 0) return values.slice()
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - windowRadius)
    const hi = Math.min(values.length - 1, i + windowRadius)
    let sum = 0
    for (let j = lo; j <= hi; j++) sum += values[j]
    out.push(sum / (hi - lo + 1))
  }
  return out
}

function filterElevationNoise(values: number[], noiseThresholdMeters: number): number[] {
  if (values.length < 2) return values.slice()
  const filtered = [values[0]]
  let lastExtreme = values[0]
  let direction: -1 | 0 | 1 = 0
  for (let i = 1; i < values.length; i++) {
    const v = values[i]
    if (direction === 0) {
      if (Math.abs(v - lastExtreme) >= noiseThresholdMeters) {
        direction = v > lastExtreme ? 1 : -1
        lastExtreme = v
        filtered.push(v)
      }
    } else if (direction === 1) {
      if (v >= lastExtreme) {
        lastExtreme = v
        filtered[filtered.length - 1] = v
      } else if (lastExtreme - v >= noiseThresholdMeters) {
        direction = -1
        lastExtreme = v
        filtered.push(v)
      }
    } else {
      if (v <= lastExtreme) {
        lastExtreme = v
        filtered[filtered.length - 1] = v
      } else if (v - lastExtreme >= noiseThresholdMeters) {
        direction = 1
        lastExtreme = v
        filtered.push(v)
      }
    }
  }
  return filtered
}

function mToFt(m: number): number {
  return m * 3.28084
}

function resolveStopNode(graph: TrailGraph, id: string, lat: number, lon: number): string {
  const known = graph.campsiteNodeIds.get(id)
  if (known) return known
  // Mirrors how the live /api/route resolves a raw "lat,lon" stop or a campsite id that isn't
  // pre-registered in the graph — attachPointToNetwork mutates the in-memory graph to snap it on.
  return attachPointToNetwork(graph, { lat, lon })
}

async function buildProfile(dataDir: string, edges: GraphEdge[]): Promise<number[]> {
  const profile: number[] = []
  for (const edge of edges) {
    const samples = densifyPolyline(edge.polyline, SAMPLE_SPACING_METERS)
    const elevs = samples.map((s: LonLat) => (hasDem(dataDir) ? getDemElevationMeters(dataDir, s) : null) ?? 0)
    profile.push(...(profile.length > 0 ? elevs.slice(1) : elevs))
  }
  return profile
}

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    return i === -1 ? undefined : args[i + 1]
  }
  return {
    park: get('--park'),
    route: get('--route'),
    leg: get('--leg') != null ? Number(get('--leg')) : undefined,
    pad: get('--pad') != null ? Number(get('--pad')) : 0.01,
  }
}

async function main() {
  const { park: parkId, route: routeName, leg: legIndex, pad } = parseArgs()
  if (!parkId) {
    console.error('Usage: npx tsx src/scripts/sweepElevationFilter.ts --park <parkId> [--route "<name>" --leg <n>] [--pad <deg>]')
    process.exit(1)
  }
  const park = PARKS.find((p) => p.id === parkId)
  if (!park) {
    console.error('Unknown park id:', parkId, '— see src/parks.ts')
    process.exit(1)
  }
  const dataDir = park.dataDir
  const { graph } = loadParkNetwork(park)

  const testRoutes = JSON.parse(readFileSync('../testing/test-routes.json', 'utf8')).routes.filter((r: any) => r.park === parkId)
  const komootResults = JSON.parse(readFileSync('../testing/komoot-results.json', 'utf8'))

  type LegTarget = {
    route: string
    from: string
    to: string
    fromId: string
    toId: string
    fromLat: number
    fromLon: number
    toLat: number
    toLon: number
    kGainFt: number
    kLossFt: number
  }
  const allTargets: LegTarget[] = []
  for (const route of testRoutes) {
    const kroute = komootResults.find((k: any) => k.park === parkId && k.name === route.name)
    if (!kroute) continue
    for (let i = 0; i < route.stops.length - 1; i++) {
      const from = route.stops[i]
      const to = route.stops[i + 1]
      const kleg = kroute.legs[i]
      const kd = kleg?.komoot
      if (!kd?.elevationGain || !kd?.elevationLoss) continue
      const kGainFt = kd.elevationGain.unit === 'm' ? mToFt(kd.elevationGain.value) : kd.elevationGain.value
      const kLossFt = kd.elevationLoss.unit === 'm' ? mToFt(kd.elevationLoss.value) : kd.elevationLoss.value
      allTargets.push({
        route: route.name,
        from: from.name,
        to: to.name,
        fromId: from.id,
        toId: to.id,
        fromLat: from.lat,
        fromLon: from.lon,
        toLat: to.lat,
        toLon: to.lon,
        kGainFt,
        kLossFt,
      })
    }
  }

  // ---------- corridor (single-leg) mode ----------
  if (routeName != null && legIndex != null) {
    const target = allTargets.filter((x) => x.route === routeName)[legIndex]
    if (!target) {
      console.error('Leg not found — check --route name and --leg index, and that Komoot data exists for it')
      process.exit(1)
    }
    const fromNode = resolveStopNode(graph, target.fromId, target.fromLat, target.fromLon)
    const toNode = resolveStopNode(graph, target.toId, target.toLat, target.toLon)
    const path = shortestPath(graph, fromNode, toNode)
    if (!path) {
      console.error('No path found between these stops — this is a routing-gap issue, not a filter one. See diagnoseRoutingGap.ts.')
      process.exit(1)
    }
    console.log('target leg edges:', path.edges.length, '| distance:', (path.totalDistanceMeters / 1609.34).toFixed(2), 'mi')

    let minLat = Infinity,
      maxLat = -Infinity,
      minLon = Infinity,
      maxLon = -Infinity
    for (const edge of path.edges)
      for (const p of edge.polyline) {
        minLat = Math.min(minLat, p.lat)
        maxLat = Math.max(maxLat, p.lat)
        minLon = Math.min(minLon, p.lon)
        maxLon = Math.max(maxLon, p.lon)
      }
    const bbox: [number, number, number, number] = [minLat - pad, minLon - pad, maxLat + pad, maxLon + pad]
    console.log('tight bbox (padded ±' + pad + '°):', JSON.stringify(bbox))
    console.log('komoot: gain', Math.round(target.kGainFt), 'loss', Math.round(target.kLossFt))

    const profile = await buildProfile(dataDir, path.edges)

    console.log('\n--- sweep (minimizing the worse of gain/loss %-error) ---')
    let best = { window: 0, threshold: 0, err: Infinity, gainFt: 0, lossFt: 0 }
    for (let w = 0; w <= 12; w++) {
      for (let th = 1; th <= 40; th++) {
        const filtered = filterElevationNoise(movingAverage(profile, w), th)
        let gainM = 0,
          lossM = 0
        for (let i = 1; i < filtered.length; i++) {
          const d = filtered[i] - filtered[i - 1]
          if (d > 0) gainM += d
          else lossM += -d
        }
        const gainFt = mToFt(gainM),
          lossFt = mToFt(lossM)
        const err = Math.max(Math.abs((gainFt - target.kGainFt) / target.kGainFt) * 100, Math.abs((lossFt - target.kLossFt) / target.kLossFt) * 100)
        if (err < best.err) best = { window: w, threshold: th, err, gainFt: Math.round(gainFt), lossFt: Math.round(lossFt) }
      }
    }
    console.log('BEST:', JSON.stringify(best))
    console.log('  at best: gain', best.gainFt, 'vs komoot', Math.round(target.kGainFt), '| loss', best.lossFt, 'vs komoot', Math.round(target.kLossFt))
    if (best.err > 30) {
      console.log(
        '\n⚠️  Best achievable error is still >30% — before trusting a corridor override, check the RAW\n' +
          '   (unfiltered) signal: re-run with a huge threshold sweep floor, or eyeball window=0,threshold=0\n' +
          "   in the detail above. If raw gain/loss is already far below Komoot's number, filtering can only\n" +
          "   make it smaller — that's a DEM/trail-digitization-resolution ceiling, not a tunable one. If\n" +
          '   distance is also off from Komoot, it may be a path-choice divergence instead. Either way, this\n' +
          '   is a "restructure/remove the test leg" case, not a filter-tuning one — see testing/README.md.',
      )
    }

    console.log('\n--- bbox leakage check across every other leg in', parkId, '---')
    let anyLeak = false
    for (const route of testRoutes) {
      for (let i = 0; i < route.stops.length - 1; i++) {
        if (route.name === routeName && i === legIndex) continue
        const f = route.stops[i],
          t2 = route.stops[i + 1]
        const fn = resolveStopNode(graph, f.id, f.lat, f.lon)
        const tn = resolveStopNode(graph, t2.id, t2.lat, t2.lon)
        const p = shortestPath(graph, fn, tn)
        if (!p) continue
        let total = 0,
          inside = 0
        for (const e of p.edges)
          for (const pt of e.polyline) {
            total++
            if (pt.lat >= bbox[0] && pt.lat <= bbox[2] && pt.lon >= bbox[1] && pt.lon <= bbox[3]) inside++
          }
        const coverage = total ? inside / total : 0
        if (coverage > 0.15) {
          anyLeak = true
          const pathMeters = p.totalDistanceMeters
          console.log(
            '  LEAK:',
            route.name,
            '|',
            f.name,
            '->',
            t2.name,
            'coverage=' + (coverage * 100).toFixed(0) + '%',
            'pathMeters=' + Math.round(pathMeters),
            coverage > 0.5 ? '(would trigger at default minCoverage:0.5 — verify this leg is OK with the new config, or add minPathMeters to exclude it)' : '',
          )
        }
      }
    }
    if (!anyLeak) console.log('  none — this bbox is safely specific to this corridor.')
    return
  }

  // ---------- park-wide mode ----------
  console.log('Legs with Komoot data for', parkId, ':', allTargets.length)
  const profiles: { t: LegTarget; profile: number[] }[] = []
  for (const t of allTargets) {
    const fromNode = resolveStopNode(graph, t.fromId, t.fromLat, t.fromLon)
    const toNode = resolveStopNode(graph, t.toId, t.toLat, t.toLon)
    const path = shortestPath(graph, fromNode, toNode)
    if (!path) {
      console.log('  skip (no path):', t.route, t.from, '->', t.to)
      continue
    }
    profiles.push({ t, profile: await buildProfile(dataDir, path.edges) })
  }
  console.log('Profiles built:', profiles.length)

  const windows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]
  const thresholds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18, 20, 25, 30, 35, 40]
  let best = { window: 0, threshold: 25, within10: -1, avgWorst: Infinity }
  for (const w of windows) {
    for (const th of thresholds) {
      let within10 = 0,
        scored = 0,
        worstSum = 0
      for (const { t, profile } of profiles) {
        const filtered = filterElevationNoise(movingAverage(profile, w), th)
        let gainM = 0,
          lossM = 0
        for (let i = 1; i < filtered.length; i++) {
          const d = filtered[i] - filtered[i - 1]
          if (d > 0) gainM += d
          else lossM += -d
        }
        const gainFt = mToFt(gainM),
          lossFt = mToFt(lossM)
        for (const [kVal, newVal] of [
          [t.kGainFt, gainFt],
          [t.kLossFt, lossFt],
        ] as const) {
          if (Math.abs(kVal) < FLOOR_FT) continue
          scored++
          const pct = Math.abs((newVal - kVal) / kVal) * 100
          if (pct <= QUALIFY_PCT) within10++
          worstSum += pct
        }
      }
      const avgWorst = scored > 0 ? worstSum / scored : Infinity
      if (within10 > best.within10 || (within10 === best.within10 && avgWorst < best.avgWorst)) {
        best = { window: w, threshold: th, within10, avgWorst }
      }
    }
  }
  console.log('\nBEST for', parkId, ':', JSON.stringify(best))
  console.log('\n--- detail at best config (compare against current PARK_FILTER_CONFIG before applying) ---')
  for (const { t, profile } of profiles) {
    const filtered = filterElevationNoise(movingAverage(profile, best.window), best.threshold)
    let gainM = 0,
      lossM = 0
    for (let i = 1; i < filtered.length; i++) {
      const d = filtered[i] - filtered[i - 1]
      if (d > 0) gainM += d
      else lossM += -d
    }
    const gainFt = Math.round(mToFt(gainM)),
      lossFt = Math.round(mToFt(lossM))
    const gainDiff = gainFt - t.kGainFt,
      lossDiff = lossFt - t.kLossFt
    const gainPct = Math.abs(t.kGainFt) >= FLOOR_FT ? ((gainDiff / t.kGainFt) * 100).toFixed(1) + '%' : 'n/a'
    const lossPct = Math.abs(t.kLossFt) >= FLOOR_FT ? ((lossDiff / t.kLossFt) * 100).toFixed(1) + '%' : 'n/a'
    const flag = (Math.abs(gainDiff) > QUALIFY_FT && gainPct !== 'n/a' && Math.abs(parseFloat(gainPct)) > QUALIFY_PCT) || (Math.abs(lossDiff) > QUALIFY_FT && lossPct !== 'n/a' && Math.abs(parseFloat(lossPct)) > QUALIFY_PCT) ? '  <-- still qualifies (>10% & >125ft); consider a corridor override' : ''
    console.log(t.route, '|', t.from, '->', t.to, '| gain k=' + Math.round(t.kGainFt), 'new=' + gainFt, '(' + gainPct + ')', '| loss k=' + Math.round(t.kLossFt), 'new=' + lossFt, '(' + lossPct + ')' + flag)
  }
}

main()
