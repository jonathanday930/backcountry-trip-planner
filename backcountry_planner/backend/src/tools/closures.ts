import { PARKS } from '../parks.js'
import { fetchNpsAlerts, type NpsAlert } from '../npsApi.js'

const MAX_RETRIES = 2
const MAX_TEXT_LENGTH = 8000

/** Strips tags/scripts/styles down to plain text rather than hand-writing a structured parser —
 * conditions pages aren't consistently structured across parks/agencies and will drift over time.
 * Handing the model clean-ish plain text and letting it read for relevant closures (including
 * cross-referencing against a specific itinerary's stops) is more robust than trying to keep a
 * bespoke parser in sync with page layout changes. Only used as the non-NPS-API fallback path now
 * (see `fetchNpsAlerts` below) — kept for parks with a `trailStatusUrl` but no `npsParkCode`
 * (national forests, BLM land, etc. have no equivalent shared structured feed to call instead). */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

export interface TrailClosuresResult {
  parkId: string
  sourceUrl: string | null
  text: string | null
  note?: string
}

function formatNpsAlerts(alerts: NpsAlert[]): string {
  if (alerts.length === 0) return 'No active alerts posted for this park right now.'
  return alerts
    .map((a) => `[${a.category}] ${a.title}\n${a.description}`.trim())
    .join('\n\n')
    .slice(0, MAX_TEXT_LENGTH)
}

export async function getTrailClosures(parkId: string): Promise<TrailClosuresResult> {
  const park = PARKS.find((p) => p.id === parkId)
  if (!park) return { parkId, sourceUrl: null, text: null, note: 'Unknown park.' }

  if (park.npsParkCode) {
    const alerts = await fetchNpsAlerts(park.npsParkCode)
    return {
      parkId,
      sourceUrl: `https://www.nps.gov/${park.npsParkCode}/planyourvisit/conditions.htm`,
      text: formatNpsAlerts(alerts),
      note: "From the National Park Service's official alerts feed — park-wide closures/hazards/conditions, not narrowed to a specific trail.",
    }
  }

  if (!park.trailStatusUrl) {
    return { parkId, sourceUrl: null, text: null, note: 'No trail-status source configured for this park yet.' }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(park.trailStatusUrl, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`${park.trailStatusUrl} returned ${res.status}`)
      const html = await res.text()
      const text = htmlToPlainText(html).slice(0, MAX_TEXT_LENGTH)
      return { parkId, sourceUrl: park.trailStatusUrl, text }
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
    }
  }
  throw new Error('unreachable')
}
