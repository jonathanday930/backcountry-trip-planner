import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { PARKS } from '../parks.js'
import { getOrLoadParkState } from '../parkState.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', '..', 'data')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

// Recreation.gov's own site-availability API for a permit, discovered by capturing the network
// traffic behind its "Detailed Availability" page rather than driving that page's UI directly —
// it's public (no cookies/login/session needed, confirmed via a bare `curl`) and returns richer
// data per day than the page itself renders: `remaining` (still online-bookable count) and
// `show_walkup` (whether the UI would show the walk-up-only "In-Station" icon once `remaining`
// hits 0) — cross-checked against the live grid for Atlantic Creek's division on 2026-09-04/05/06
// and matched exactly (remaining 1/0/0, show_walkup false/true/true). No group-size or
// starting-area parameter exists on this endpoint at all — it's purely per-division, per-day.
function availabilityUrl(permitId: string, divisionId: string, year: number, month: number): string {
  return `https://www.recreation.gov/api/permititinerary/${permitId}/division/${divisionId}/availability/month?month=${month}&year=${year}`
}

interface DivisionMonthPayload {
  quota_type_maps?: { QuotaUsageBySiteDaily?: Record<string, { total: number; remaining: number; show_walkup: boolean }> }
}

async function fetchDivisionMonth(permitId: string, divisionId: string, year: number, month: number): Promise<DivisionMonthPayload> {
  const res = await fetch(availabilityUrl(permitId, divisionId, year, month), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`recreation.gov returned ${res.status} for division ${divisionId} ${year}-${month}`)
  const body = (await res.json()) as { payload: DivisionMonthPayload }
  return body.payload
}

interface CacheRow {
  payload: string
  scraped_at: string
}

function getCached(cacheKey: string): DivisionMonthPayload | null {
  const row = db
    .prepare(`SELECT payload, scraped_at FROM permit_availability_cache WHERE cache_key = ? AND expires_at > datetime('now')`)
    .get(cacheKey) as CacheRow | undefined
  return row ? JSON.parse(row.payload) : null
}

function setCached(cacheKey: string, parkId: string, permitId: string, divisionId: string, payload: DivisionMonthPayload) {
  db.prepare(
    `INSERT INTO permit_availability_cache (cache_key, park_id, permit_id, division_id, payload, scraped_at, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', '+6 hours'))
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, scraped_at = excluded.scraped_at, expires_at = excluded.expires_at`,
  ).run(cacheKey, parkId, permitId, divisionId, JSON.stringify(payload))
  db.prepare(`DELETE FROM permit_availability_cache WHERE expires_at < datetime('now')`).run()
}

async function getDivisionMonth(parkId: string, permitId: string, divisionId: string, year: number, month: number): Promise<DivisionMonthPayload> {
  const cacheKey = `${parkId}:${permitId}:${divisionId}:${year}-${month}`
  const cached = getCached(cacheKey)
  if (cached) return cached
  const payload = await fetchDivisionMonth(permitId, divisionId, year, month)
  setCached(cacheKey, parkId, permitId, divisionId, payload)
  return payload
}

interface DivisionMapping {
  permitId: string
  divisionIdBySlug: Record<string, string>
}

function loadDivisionMapping(dataDir: string): DivisionMapping | null {
  const filePath = path.join(DATA_DIR, dataDir, 'permit-divisions.json')
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

export interface DayAvailability {
  date: string
  totalSites: number
  remainingOnline: number
  /** True once `remainingOnline` hits 0 and Recreation.gov would show its "In-Station" (walk-up
   * only, obtainable in person up to 1 day ahead, no guarantee) indicator for this date. */
  walkupOnly: boolean
  /** True when `totalSites` is 0 — Recreation.gov has no bookable quota configured for this site
   * on this date at all (seen for some sites on some dates; likely season-boundary related, not a
   * live "sold out" state). `remainingOnline` can go negative when this is true and isn't
   * meaningful — `walkupOnly` is always false here rather than guessing. */
  noQuotaConfigured: boolean
}

export interface SiteAvailability {
  siteToken: string
  siteName: string
  days: DayAvailability[]
}

export interface PermitAvailabilityResult {
  parkId: string
  asOf: string
  sites: SiteAvailability[]
  /** Tokens that aren't a known campsite with a permit-division mapping (e.g. a trailhead, which
   * isn't itself reservable, or a typo) — surfaced so the model can say so rather than guess. */
  unresolved: string[]
}

function monthsInRange(startDate: string, endDate: string): { year: number; month: number }[] {
  const start = new Date(startDate + 'T00:00:00Z')
  const end = new Date(endDate + 'T00:00:00Z')
  const months: { year: number; month: number }[] = []
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cur <= end) {
    months.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1 })
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return months
}

export async function checkPermitAvailability(params: {
  parkId: string
  siteTokens: string[]
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD, inclusive
}): Promise<PermitAvailabilityResult> {
  const { parkId, siteTokens, startDate, endDate } = params
  const park = PARKS.find((p) => p.id === parkId)
  if (!park) throw new Error(`Unknown park "${parkId}"`)
  if (!park.permits || park.permits.length === 0) {
    return { parkId, asOf: new Date().toISOString(), sites: [], unresolved: siteTokens }
  }

  const state = getOrLoadParkState(parkId)
  const mapping = loadDivisionMapping(park.dataDir)
  if (!mapping) {
    return { parkId, asOf: new Date().toISOString(), sites: [], unresolved: siteTokens }
  }

  const months = monthsInRange(startDate, endDate)
  const sites: SiteAvailability[] = []
  const unresolved: string[] = []

  for (const token of siteTokens) {
    const divisionId = mapping.divisionIdBySlug[token]
    if (!divisionId) {
      unresolved.push(token)
      continue
    }
    const siteName = state?.campsites.find((c) => c.id === token)?.name ?? token

    const days: DayAvailability[] = []
    for (const { year, month } of months) {
      const payload = await getDivisionMonth(parkId, mapping.permitId, divisionId, year, month)
      const daily = payload.quota_type_maps?.QuotaUsageBySiteDaily ?? {}
      for (const [date, info] of Object.entries(daily)) {
        if (date < startDate || date > endDate) continue
        const noQuotaConfigured = info.total === 0
        days.push({
          date,
          totalSites: info.total,
          remainingOnline: info.remaining,
          walkupOnly: !noQuotaConfigured && info.remaining === 0 && info.show_walkup,
          noQuotaConfigured,
        })
      }
    }
    days.sort((a, b) => a.date.localeCompare(b.date))
    sites.push({ siteToken: token, siteName, days })
  }

  return { parkId, asOf: new Date().toISOString(), sites, unresolved }
}
