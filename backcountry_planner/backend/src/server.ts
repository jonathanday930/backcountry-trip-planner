import 'dotenv/config'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { computeRouteElevation } from './elevation.js'
import type { LonLat } from './geo.js'
import { PARKS } from './parks.js'
import { getOrLoadParkState, resolveStopCoordinate, type ParkState } from './parkState.js'
import { getHazards } from './hazards.js'
import { buildRouteSubgraph, UnroutableStopError, type ResolvedStop } from './routeSubgraph.js'
import { authRouter } from './auth.js'
import { savedRoutesRouter } from './savedRoutes.js'
import { chatRouter } from './chat.js'
import { DEMO_MODE, getDemStatus, startDemDownload } from './demDownload.js'
import { getKnownRoutes } from './tools/knownRoutes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const METERS_TO_MILES = 1 / 1609.344
const METERS_TO_FEET = 3.28084
/** Matches the frontend's cap — each additional stop is another shortest-path + live elevation lookup. */
const MAX_STOPS = 25

function getParkState(req: express.Request, res: express.Response): ParkState | null {
  const parkId = String(req.query.park ?? PARKS[0].id)
  const state = getOrLoadParkState(parkId)
  if (!state) {
    res.status(400).json({ error: `Unknown park "${parkId}"` })
    return null
  }
  return state
}

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'

const app = express()
app.use(cors({ origin: FRONTEND_URL, credentials: true }))
app.use(cookieParser())
app.use(express.json())

app.use('/api/auth', authRouter)
app.use('/api/saved-routes', savedRoutesRouter)
app.use('/api/chat', chatRouter)

app.get('/api/parks', (_req, res) => {
  res.json(PARKS.map((p) => ({ id: p.id, name: p.name, center: p.center })))
})

app.get('/api/config', (_req, res) => {
  res.json({ demoMode: DEMO_MODE })
})

app.get('/api/dem/status', (req, res) => {
  const park = PARKS.find((p) => p.id === String(req.query.park ?? ''))
  if (!park) return res.status(400).json({ error: 'Unknown park' })
  res.json(getDemStatus(park.dataDir))
})

app.post('/api/dem/download', (req, res) => {
  if (!DEMO_MODE) return res.status(403).json({ error: 'Elevation downloads are disabled (demo mode is off).' })
  const status = startDemDownload(String(req.query.park ?? ''))
  if (!status) return res.status(400).json({ error: 'Unknown park' })
  res.status(202).json(status)
})

app.get('/api/known-routes', async (req, res) => {
  const parkId = String(req.query.park ?? PARKS[0].id)
  try {
    res.json(await getKnownRoutes(parkId))
  } catch (err) {
    console.error('[known-routes] lookup failed:', err)
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to load known routes' })
  }
})

app.get('/api/campsites', (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  res.json(
    state.campsites.map((c) => ({
      id: c.id,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      type: c.type,
      context: c.context,
      startingAreas: c.startingAreas,
      closed: c.closed,
      closedAsOf: c.closedAsOf,
    })),
  )
})

app.get('/api/route', async (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  const { id: parkId, dataDir, trails, campsites } = state

  const stopIds = String(req.query.stops ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)

  if (stopIds.length < 2) {
    res.status(400).json({ error: 'Provide at least two stops, e.g. ?stops=id1|id2|36.08,-112.15' })
    return
  }
  if (stopIds.length > MAX_STOPS) {
    res.status(400).json({ error: `Routes are limited to ${MAX_STOPS} stops` })
    return
  }

  const resolvedStops: ResolvedStop[] = []
  for (const token of stopIds) {
    const resolved = resolveStopCoordinate(campsites, token)
    if (!resolved) {
      res.status(400).json({ error: `Unknown stop "${token}"` })
      return
    }
    resolvedStops.push(resolved)
  }

  let routeSubgraph: ReturnType<typeof buildRouteSubgraph>
  try {
    routeSubgraph = buildRouteSubgraph(trails, campsites, parkId, resolvedStops)
  } catch (err) {
    if (err instanceof UnroutableStopError) {
      res.status(400).json({ error: err.message })
      return
    }
    throw err
  }

  try {
    const legOutcomes = routeSubgraph.legs
    // A map-clicked point may be away from the trail. Tell the client exactly how far it is
    // from the network and where it joins, rather than making an off-trail spur look like trail.
    const customPointSnaps = resolvedStops.flatMap((stop, index) => {
      if (stop.campsiteId) return []
      const nodeId = routeSubgraph.stopNodes[index].nodeId
      const node = routeSubgraph.graph.nodes.get(nodeId)
      if (!node || !nodeId.startsWith('adhoc-p')) {
        return [{ pointToken: stop.token, distanceMeters: 0, nearestTrailPoint: [stop.lon, stop.lat] as [number, number] }]
      }
      const spur = routeSubgraph.graph.adjacency.get(nodeId)?.[0]
      const nearest = spur?.polyline[spur.polyline.length - 1] as LonLat | undefined
      return [{
        pointToken: stop.token,
        distanceMeters: spur?.distanceMeters ?? 0,
        nearestTrailPoint: nearest ? [nearest.lon, nearest.lat] as [number, number] : [stop.lon, stop.lat] as [number, number],
      }]
    })
    const legs: {
      from: string
      to: string
      distanceMiles: number
      elevationGainFt: number
      elevationLossFt: number
      /** This leg's own polyline (lon,lat), so the frontend can color each day of a multi-day trek separately. */
      coordinates: [number, number][]
    }[] = []
    const coordinates: [number, number][] = []
    let totalDistanceMeters = 0
    let totalGainMeters = 0
    let totalLossMeters = 0

    for (let i = 0; i < legOutcomes.length; i++) {
      const fromId = stopIds[i]
      const toId = stopIds[i + 1]
      const outcome = legOutcomes[i]

      if (outcome.kind === 'same-node') {
        legs.push({ from: fromId, to: toId, distanceMiles: 0, elevationGainFt: 0, elevationLossFt: 0, coordinates: [] })
        continue
      }
      if (outcome.kind === 'no-route') {
        res.status(404).json({ error: `No route found between "${fromId}" and "${toId}"` })
        return
      }

      const path = outcome.path
      const { gainMeters, lossMeters } = await computeRouteElevation(dataDir, path.edges)

      const legCoordinates: [number, number][] = []
      for (const edge of path.edges) {
        for (const p of edge.polyline as LonLat[]) {
          const last = legCoordinates[legCoordinates.length - 1]
          if (last && last[0] === p.lon && last[1] === p.lat) continue
          legCoordinates.push([p.lon, p.lat])
        }
      }
      for (const p of legCoordinates) {
        const last = coordinates[coordinates.length - 1]
        if (last && last[0] === p[0] && last[1] === p[1]) continue
        coordinates.push(p)
      }

      totalDistanceMeters += path.totalDistanceMeters
      totalGainMeters += gainMeters
      totalLossMeters += lossMeters
      legs.push({
        from: fromId,
        to: toId,
        distanceMiles: path.totalDistanceMeters * METERS_TO_MILES,
        elevationGainFt: gainMeters * METERS_TO_FEET,
        elevationLossFt: lossMeters * METERS_TO_FEET,
        coordinates: legCoordinates,
      })
    }

    res.json({
      distanceMiles: totalDistanceMeters * METERS_TO_MILES,
      elevationGainFt: totalGainMeters * METERS_TO_FEET,
      elevationLossFt: totalLossMeters * METERS_TO_FEET,
      routeGeoJson: { type: 'LineString', coordinates },
      legs,
      customPointSnaps,
    })
  } catch (err) {
    console.error('[route] elevation lookup failed:', err)
    res.status(502).json({ error: 'Elevation lookup failed, please try again' })
  }
})

app.get('/api/trails', (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  res.json(state.trails)
})

app.get('/api/zones', (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  res.json(state.zones)
})

app.get('/api/boundary', (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  res.json(state.boundary)
})

// National Park Service units only (see hazards.ts) — parks without an npsParkCode get an empty
// result rather than a 400, so the frontend can fetch this unconditionally like /api/zones.
app.get('/api/hazards', async (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  try {
    res.json(await getHazards(state.id))
  } catch (err) {
    console.error('[hazards] fetch failed:', err)
    res.status(502).json({ error: 'Failed to load park hazards' })
  }
})

// Any /api/* route that fell through the handlers above doesn't exist — 404 as JSON rather than
// letting it fall into the SPA catch-all below and get served index.html.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// In production the frontend is built (`npm run build` in frontend/) and served from here, so
// the whole app is one process/one port. In local dev frontend/dist doesn't exist — the frontend
// runs on its own Vite dev server (port 5173) and proxies /api here instead, exactly as before.
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist')
if (existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
  console.log(`[server] serving frontend build from ${FRONTEND_DIST}`)
} else {
  console.log('[server] frontend/dist not found — API-only mode (run the frontend dev server separately)')
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})
