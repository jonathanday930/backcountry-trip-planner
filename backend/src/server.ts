import 'dotenv/config'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { loadCampsites, loadTrails } from './data.js'
import { attachPointToNetwork, buildGraph, shortestPath, type TrailGraph } from './graph.js'
import { computeRouteElevation } from './elevation.js'
import type { LonLat } from './geo.js'
import type { Campsite, TrailsGeoJson } from './types.js'
import { PARKS } from './parks.js'
import { authRouter } from './auth.js'
import { savedRoutesRouter } from './savedRoutes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const METERS_TO_MILES = 1 / 1609.344
const METERS_TO_FEET = 3.28084
/** Matches the frontend's cap — each additional stop is another shortest-path + live elevation lookup. */
const MAX_STOPS = 25
/** stops are "|"-separated; each token is either a known campsite id, or a raw "lat,lon" point. */
const RAW_POINT_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

interface ParkState {
  campsites: Campsite[]
  trails: TrailsGeoJson
  graph: TrailGraph
}

const parkStates = new Map<string, ParkState>()
for (const park of PARKS) {
  const campsites = loadCampsites(park.dataDir)
  const trails = loadTrails(park.dataDir)
  const graph = buildGraph(trails, campsites)
  parkStates.set(park.id, { campsites, trails, graph })
  console.log(`[graph] ${park.id}: ${graph.nodes.size} nodes, ${graph.edges.length} edges, ${campsites.length} campsites snapped`)
}

function getParkState(req: express.Request, res: express.Response): ParkState | null {
  const parkId = String(req.query.park ?? PARKS[0].id)
  const state = parkStates.get(parkId)
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

app.get('/api/parks', (_req, res) => {
  res.json(PARKS.map((p) => ({ id: p.id, name: p.name, center: p.center })))
})

app.get('/api/campsites', (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  res.json(
    state.campsites.map((c) => ({ id: c.id, name: c.name, lat: c.lat, lon: c.lon, type: c.type, context: c.context })),
  )
})

function resolveStop(graph: TrailGraph, token: string): string | null {
  const campsiteNode = graph.campsiteNodeIds.get(token)
  if (campsiteNode) return campsiteNode

  const match = token.match(RAW_POINT_RE)
  if (match) {
    const lat = Number(match[1])
    const lon = Number(match[2])
    return attachPointToNetwork(graph, { lat, lon })
  }
  return null
}

app.get('/api/route', async (req, res) => {
  const state = getParkState(req, res)
  if (!state) return
  const { graph } = state

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

  const stopNodes = stopIds.map((id) => ({ id, node: resolveStop(graph, id) }))
  const unknown = stopNodes.find((s) => !s.node)
  if (unknown) {
    res.status(400).json({ error: `Unknown stop "${unknown.id}"` })
    return
  }

  try {
    const legs: { from: string; to: string; distanceMiles: number; elevationGainFt: number; elevationLossFt: number }[] = []
    const coordinates: [number, number][] = []
    let totalDistanceMeters = 0
    let totalGainMeters = 0
    let totalLossMeters = 0

    for (let i = 0; i < stopNodes.length - 1; i++) {
      const fromStop = stopNodes[i]
      const toStop = stopNodes[i + 1]

      if (fromStop.node === toStop.node) {
        legs.push({ from: fromStop.id, to: toStop.id, distanceMiles: 0, elevationGainFt: 0, elevationLossFt: 0 })
        continue
      }

      const path = shortestPath(graph, fromStop.node!, toStop.node!)
      if (!path) {
        res.status(404).json({ error: `No route found between "${fromStop.id}" and "${toStop.id}"` })
        return
      }

      const { gainMeters, lossMeters } = await computeRouteElevation(path.edges)

      for (const edge of path.edges) {
        for (const p of edge.polyline as LonLat[]) {
          const last = coordinates[coordinates.length - 1]
          if (last && last[0] === p.lon && last[1] === p.lat) continue
          coordinates.push([p.lon, p.lat])
        }
      }

      totalDistanceMeters += path.totalDistanceMeters
      totalGainMeters += gainMeters
      totalLossMeters += lossMeters
      legs.push({
        from: fromStop.id,
        to: toStop.id,
        distanceMiles: path.totalDistanceMeters * METERS_TO_MILES,
        elevationGainFt: gainMeters * METERS_TO_FEET,
        elevationLossFt: lossMeters * METERS_TO_FEET,
      })
    }

    res.json({
      distanceMiles: totalDistanceMeters * METERS_TO_MILES,
      elevationGainFt: totalGainMeters * METERS_TO_FEET,
      elevationLossFt: totalLossMeters * METERS_TO_FEET,
      routeGeoJson: { type: 'LineString', coordinates },
      legs,
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
