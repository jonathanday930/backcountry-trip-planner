const MAX_RETRIES = 2
const ALERTS_URL = 'https://developer.nps.gov/api/v1/alerts'
const ROAD_EVENTS_URL = 'https://developer.nps.gov/api/v1/roadevents'

async function fetchNpsJson(url: string): Promise<any> {
  const apiKey = process.env.NPS_API_KEY
  if (!apiKey) throw new Error('NPS_API_KEY is not set — get a free key at https://www.nps.gov/subjects/developer/get-started.htm')

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`NPS API returned ${res.status} for ${url}`)
      return await res.json()
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
    }
  }
  throw new Error('unreachable')
}

export interface NpsAlert {
  title: string
  description: string
  category: string
  url: string
  /** Titles of road events NPS itself says this alert is about — confirmed live (Mount Rainier,
   * 2026-09-08): this array's `title` reliably exact-matches a `fetchNpsRoadEvents` feature's own
   * title, but its `id` does NOT (it's a different id scheme, not the road event's own `Id`), so
   * `hazards.ts` links the two by title, not id. When a match exists, that's an official NPS
   * location for the alert — used before ever falling back to the AI best-effort matcher. */
  relatedRoadEventTitles: string[]
}

/** NPS's structured alerts feed — official closures/hazards/conditions per park unit. No
 * coordinates of its own (confirmed live): that's why `hazards.ts` only uses this feed directly
 * for the "can't be pinned" bucket, unless a `relatedRoadEventTitles` link or the AI matcher
 * places it, and relies on `fetchNpsRoadEvents` below (which does carry real geometry) for
 * anything else that should get a map pin directly. */
export async function fetchNpsAlerts(parkCode: string): Promise<NpsAlert[]> {
  const apiKey = process.env.NPS_API_KEY
  const body = await fetchNpsJson(`${ALERTS_URL}?parkCode=${parkCode}&limit=50&api_key=${apiKey}`)
  const data = (body?.data ?? []) as any[]
  return data.map((a) => ({
    title: a.title ?? '',
    description: a.description ?? '',
    category: a.category ?? 'Information',
    url: a.url ?? '',
    relatedRoadEventTitles: ((a.relatedRoadEvents ?? []) as any[]).map((r) => r.title).filter(Boolean),
  }))
}

export interface NpsRoadEvent {
  id: string
  title: string
  description: string
  category: string
  url: string
  /** [lon, lat] — the event's own geometry reduced to a single representative point (its first
   * coordinate for a line/polygon). Undefined if the event carried no usable geometry at all. */
  point?: [number, number]
}

/** Confirmed against a live response (Mount Rainier, 2026-09-08): NPS's road events feed follows
 * the WZDx (Work Zone Data Exchange, https://github.com/usdot-jpo-ode/wzdx) v4.1 standard — the
 * response body itself *is* a single GeoJSON `FeatureCollection` (`{ road_event_feed_info,
 * features, type }`), not a `{ data: [...] }` wrapper. Each feature's real fields, per that spec:
 * `properties.Id`, `properties.core_details.{name, description, road_names, event_type}`,
 * `properties.vehicle_impact` (e.g. "all-lanes-closed", "some-lanes-closed",
 * "alternating-one-way", "all-lanes-open") — there's no per-event URL in this standard, so `url`
 * always falls back to the park's general conditions page. `vehicle_impact` is mapped onto the
 * same category vocabulary /alerts uses (Park Closure/Caution/Information) so the frontend's one
 * legend/color scheme covers both feeds. */
export async function fetchNpsRoadEvents(parkCode: string): Promise<NpsRoadEvent[]> {
  const apiKey = process.env.NPS_API_KEY
  const body = await fetchNpsJson(`${ROAD_EVENTS_URL}?parkCode=${parkCode}&api_key=${apiKey}`)
  const features = (body?.features ?? []) as any[]
  const fallbackUrl = `https://www.nps.gov/${parkCode}/planyourvisit/conditions.htm`

  const events: NpsRoadEvent[] = []
  for (const feature of features) {
    const props = feature?.properties ?? {}
    const core = props.core_details ?? {}
    const title = core.name || core.road_names?.join(', ') || 'Road event'
    const point = firstPoint(feature?.geometry)
    if (!point) {
      console.warn(`[nps:roadevents] ${parkCode}: feature with no usable geometry, skipped —`, JSON.stringify(feature).slice(0, 300))
      continue
    }
    events.push({
      id: props.Id ?? `${parkCode}-${events.length}`,
      title,
      description: core.description ?? '',
      category: categoryFromVehicleImpact(props.vehicle_impact),
      url: fallbackUrl,
      point,
    })
  }
  return events
}

function categoryFromVehicleImpact(impact: string | undefined): string {
  switch (impact) {
    case 'all-lanes-closed':
      return 'Park Closure'
    case 'some-lanes-closed':
    case 'alternating-one-way':
      return 'Caution'
    case 'all-lanes-open':
      return 'Information'
    default:
      return 'Caution'
  }
}

function firstPoint(geometry: any): [number, number] | undefined {
  if (!geometry) return undefined
  const { type, coordinates } = geometry
  if (type === 'Point') return coordinates as [number, number]
  if (type === 'LineString') return coordinates?.[0] as [number, number]
  if (type === 'Polygon') return coordinates?.[0]?.[0] as [number, number]
  if (type === 'MultiLineString') return coordinates?.[0]?.[0] as [number, number]
  if (type === 'MultiPolygon') return coordinates?.[0]?.[0]?.[0] as [number, number]
  return undefined
}
