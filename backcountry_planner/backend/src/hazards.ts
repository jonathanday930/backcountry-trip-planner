import { PARKS } from './parks.js'
import { getOrLoadParkState } from './parkState.js'
import { fetchNpsAlerts, fetchNpsRoadEvents } from './npsApi.js'
import { locateAlert, type LocationCandidate } from './hazardLocator.js'

const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_CANDIDATES = 200

export interface HazardPin {
  id: string
  lat: number
  lon: number
  title: string
  description: string
  category: string
  url: string
  /** 'road-event' = NPS's own exact location. 'alert-match' = best-effort AI match against a
   * known place in this park — always labeled as such in the frontend popup, never presented as
   * an official location. */
  source: 'road-event' | 'alert-match'
}

export interface UnlocatedHazard {
  title: string
  description: string
  category: string
  url: string
}

export interface HazardsResult {
  parkId: string
  pinned: HazardPin[]
  unlocated: UnlocatedHazard[]
  asOf: string
}

interface CacheEntry {
  result: HazardsResult
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/** Every named, geocoded place we already know about in this park — campsites/trailheads plus
 * uniquely-named trail and road segments (deduped by name, first coordinate used as the
 * representative point) — offered to the cheap matching model as its list of things a non-road
 * alert's text might be naming. Capped so the prompt stays small even for parks with hundreds of
 * named trail segments. */
function buildLocationCandidates(parkId: string): LocationCandidate[] {
  const state = getOrLoadParkState(parkId)
  if (!state) return []

  const candidates: LocationCandidate[] = state.campsites.map((c) => ({ id: `campsite:${c.id}`, name: c.name }))

  const seenTrailNames = new Set<string>()
  for (const feature of state.trails.features) {
    const name = feature.properties.name?.trim()
    if (!name || seenTrailNames.has(name)) continue
    seenTrailNames.add(name)
    candidates.push({ id: `trail:${name}`, name })
    if (candidates.length >= MAX_CANDIDATES) break
  }

  return candidates.slice(0, MAX_CANDIDATES)
}

function resolveCandidateCoordinate(parkId: string, candidateId: string): [number, number] | null {
  const state = getOrLoadParkState(parkId)
  if (!state) return null

  if (candidateId.startsWith('campsite:')) {
    const campsiteId = candidateId.slice('campsite:'.length)
    const campsite = state.campsites.find((c) => c.id === campsiteId)
    return campsite ? [campsite.lon, campsite.lat] : null
  }
  if (candidateId.startsWith('trail:')) {
    const name = candidateId.slice('trail:'.length)
    const feature = state.trails.features.find((f) => f.properties.name === name)
    const point = feature?.geometry.coordinates[0]
    return point ? [point[0], point[1]] : null
  }
  return null
}

async function fetchFresh(parkId: string, parkCode: string): Promise<HazardsResult> {
  const [alerts, roadEvents] = await Promise.all([fetchNpsAlerts(parkCode), fetchNpsRoadEvents(parkCode)])

  // NPS's own road-event titles are unique enough in practice to key off of directly (confirmed
  // live against Mount Rainier's feed) — no case/whitespace normalization needed beyond this.
  const roadEventByTitle = new Map(roadEvents.map((e) => [e.title, e]))
  const claimedTitles = new Set<string>()

  const candidates = buildLocationCandidates(parkId)
  const pinned: HazardPin[] = []
  const unlocated: UnlocatedHazard[] = []

  for (const alert of alerts) {
    const linkedRoadEvent = alert.relatedRoadEventTitles.map((t) => roadEventByTitle.get(t)).find(Boolean)
    if (linkedRoadEvent) {
      claimedTitles.add(linkedRoadEvent.title)
      pinned.push({
        id: `alert-road:${linkedRoadEvent.id}`,
        lat: linkedRoadEvent.point![1],
        lon: linkedRoadEvent.point![0],
        title: alert.title,
        description: alert.description,
        category: alert.category,
        url: alert.url || linkedRoadEvent.url,
        source: 'road-event',
      })
      continue
    }

    const matchedId = await locateAlert(alert, candidates)
    const coordinate = matchedId ? resolveCandidateCoordinate(parkId, matchedId) : null
    if (matchedId && coordinate) {
      pinned.push({
        id: `alert:${matchedId}:${alert.title}`,
        lat: coordinate[1],
        lon: coordinate[0],
        title: alert.title,
        description: alert.description,
        category: alert.category,
        url: alert.url,
        source: 'alert-match',
      })
    } else {
      unlocated.push(alert)
    }
  }

  // Any road event not already shown via an official alert link above gets its own plain pin,
  // so a closure never disappears just because NPS hasn't (yet) posted a matching alert for it.
  for (const e of roadEvents) {
    if (claimedTitles.has(e.title)) continue
    pinned.push({ id: `road:${e.id}`, lat: e.point![1], lon: e.point![0], title: e.title, description: e.description, category: e.category, url: e.url, source: 'road-event' })
  }

  return { parkId, pinned, unlocated, asOf: new Date().toISOString() }
}

export async function getHazards(parkId: string): Promise<HazardsResult> {
  const park = PARKS.find((p) => p.id === parkId)
  if (!park?.npsParkCode) {
    return { parkId, pinned: [], unlocated: [], asOf: new Date().toISOString() }
  }

  const cached = cache.get(parkId)
  if (cached && cached.expiresAt > Date.now()) return cached.result

  const result = await fetchFresh(parkId, park.npsParkCode)
  cache.set(parkId, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}
