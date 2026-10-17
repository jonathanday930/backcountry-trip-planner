import 'dotenv/config'
import { PARKS } from '../parks.js'
import { loadParkNetwork } from '../parkNetwork.js'
import { computeRouteElevation, getElevationCacheSize, flushElevationCache } from '../elevation.js'
import { hasDem } from '../demElevation.js'

/**
 * Pre-warms the on-disk elevation cache (backend/data/elevation-cache.json) for one or more
 * parks, so a user's first-ever request for a route between two mapped points never pays the
 * cost of live USGS elevation lookups — only a genuinely novel custom map-click point does (and
 * only for its own short spur onto the trail network, not the whole route).
 *
 * This deliberately does NOT precompute a route/distance matrix between campsite pairs — the
 * slow part of routing was never the shortest-path search (plain in-memory Dijkstra, effectively
 * instant even on graphs with 100k+ nodes) or the polyline assembly, it's the elevation sampling.
 * Elevation is cached per-coordinate and per-edge already (elevation.ts), and every possible
 * route is built from edges of the same static trail/road graph, so warming every edge in a
 * park's graph exactly once covers every walkable path in that park, not just paths between
 * named campsites/trailheads.
 *
 * Usage:
 *   npx tsx src/scripts/warmElevationCache.ts <parkId> [parkId ...]
 *   npx tsx src/scripts/warmElevationCache.ts all
 *
 * Safe to re-run or interrupt (Ctrl+C) at any time: already-cached coordinates are skipped
 * (checked before ever hitting the network), and edges are processed with allSettled so one
 * network hiccup doesn't abort the rest of the run.
 */

const PROGRESS_INTERVAL_MS = 15000

async function warmPark(parkId: string) {
  const park = PARKS.find((p) => p.id === parkId)
  if (!park) {
    console.error(`Unknown park "${parkId}". Known parks: ${PARKS.map((p) => p.id).join(', ')}`)
    process.exitCode = 1
    return
  }

  if (hasDem(park.dataDir)) {
    console.log(`[warm] ${park.id}: has a local DEM already (reads are local, nothing to warm) — skipping`)
    return
  }

  console.log(`\n[warm] ${park.id}: loading network...`)
  const { graph } = loadParkNetwork(park)
  const edges = graph.edges
  console.log(`[warm] ${park.id}: ${graph.nodes.size} nodes, ${edges.length} edges to warm`)

  const startedAt = Date.now()
  const cacheAtStart = getElevationCacheSize()
  let done = 0
  let failed = 0
  const failedEdgeIds: string[] = []

  const progressTimer = setInterval(() => {
    const elapsedSec = (Date.now() - startedAt) / 1000
    const rate = done / elapsedSec
    const remaining = edges.length - done
    const etaSec = rate > 0 ? Math.round(remaining / rate) : null
    const newCoords = getElevationCacheSize() - cacheAtStart
    console.log(
      `[warm] ${park.id}: ${done}/${edges.length} edges (${failed} failed), ` +
        `${newCoords} new coords cached, ${elapsedSec.toFixed(0)}s elapsed` +
        (etaSec !== null ? `, ~${etaSec}s remaining` : ''),
    )
  }, PROGRESS_INTERVAL_MS)

  // One computeRouteElevation call per edge (rather than one call across all edges) so a single
  // failing edge doesn't fail the whole park via Promise.all — allSettled isolates each edge and
  // the run continues, reporting failures at the end instead of aborting partway through.
  const results = await Promise.allSettled(
    edges.map((edge) =>
      computeRouteElevation(park.dataDir, [edge]).finally(() => {
        done++
      }),
    ),
  )
  clearInterval(progressTimer)

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed++
      failedEdgeIds.push(edges[i].id)
    }
  })

  flushElevationCache()

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0)
  const newCoords = getElevationCacheSize() - cacheAtStart
  console.log(
    `[warm] ${park.id}: done in ${elapsedSec}s — ${edges.length - failed}/${edges.length} edges warmed, ` +
      `${newCoords} new coordinates cached`,
  )
  if (failed > 0) {
    console.log(`[warm] ${park.id}: ${failed} edge(s) failed (will retry next run): ${failedEdgeIds.slice(0, 20).join(', ')}${failedEdgeIds.length > 20 ? ', ...' : ''}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: npx tsx src/scripts/warmElevationCache.ts <parkId> [parkId ...] | all')
    process.exitCode = 1
    return
  }
  const parkIds = args[0] === 'all' ? PARKS.map((p) => p.id) : args

  for (const parkId of parkIds) {
    await warmPark(parkId)
  }
  console.log('\n[warm] all requested parks complete.')
}

main()
