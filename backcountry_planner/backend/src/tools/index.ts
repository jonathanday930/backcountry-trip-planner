import type Anthropic from '@anthropic-ai/sdk'
import { getOrLoadParkState } from '../parkState.js'
import { solveItinerary } from '../itinerarySolver.js'
import { getWeatherForecast } from './weather.js'
import { getTrailClosures } from './closures.js'
import { getKnownRoutes } from './knownRoutes.js'
import { checkPermitAvailability } from './permitAvailability.js'

export interface ToolContext {
  parkId: string
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_itinerary_splits',
    description:
      "Given an ordered corridor of real stop ids (start trailhead first, exit trailhead last, real campsites in between, in the order you'd actually walk them) and a maximum miles-per-day limit, works out how to split that corridor across a given number of nights, computing real on-trail distance and elevation for every leg. Pass one or more candidate night counts to compare — e.g. [3, 4] to see both a 3-night and 4-night version of the same corridor. Does NOT choose or reorder which stops to visit — call get_known_routes first to find a real corridor to feed in.",
    input_schema: {
      type: 'object',
      properties: {
        stops: { type: 'array', items: { type: 'string' }, description: 'Ordered stop ids, start to exit, real campsite/trailhead ids from this park.' },
        maxDailyMiles: { type: 'number', description: 'Hard cap on any single day’s on-trail mileage.' },
        nights: { type: 'array', items: { type: 'integer' }, description: 'Night counts to evaluate, e.g. [3] or [3, 4].' },
      },
      required: ['stops', 'maxDailyMiles', 'nights'],
    },
  },
  {
    name: 'get_weather_forecast',
    description: 'Live National Weather Service forecast (next ~3 days, several periods) for a specific latitude/longitude — use a stop’s own coordinates for a spot forecast, or the park’s center for a general one.',
    input_schema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lon: { type: 'number' },
      },
      required: ['lat', 'lon'],
    },
  },
  {
    name: 'get_trail_closures',
    description:
      "Current closures/hazards/conditions for the park. For National Park Service units, this is the park's official structured alerts feed (real closures and hazards, park-wide — not narrowed to one specific trail). For parks without one (national forests, BLM land, etc.), this instead reads the park's own current-conditions page as plain text, which can surface general seasonal hazard guidance rather than a live per-trail closure list if that park's specifics render through an interactive map the page's own HTML doesn't expose — read the result's own framing before claiming to have checked live per-trail status.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_permit_availability',
    description:
      "Live Recreation.gov backcountry permit availability for specific real campsite ids over a date range — for each date, how many spots are still bookable online right now, and whether the site has shifted to walk-up-only (obtainable in person up to 1 day ahead, no guarantee, not bookable online at all). Cached for up to 6 hours, so mention the check's timestamp rather than implying it's live-live. Only works for designated campsites, not trailheads.",
    input_schema: {
      type: 'object',
      properties: {
        siteTokens: { type: 'array', items: { type: 'string' }, description: 'Real campsite ids to check.' },
        startDate: { type: 'string', description: 'YYYY-MM-DD' },
        endDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['siteTokens', 'startDate', 'endDate'],
    },
  },
  {
    name: 'get_known_routes',
    description:
      'Curated list of real, well-known named backpacking routes for this park (e.g. classic multi-day traverses and loops), each with live-computed total distance/elevation. The response includes route `stops` used for geometry and `campsiteStops`, the complete ordered list of campsite/permit-area choices encountered along the corridor (including choices too close together to be separate routing waypoints). Check this before inventing or guessing at a route name — if it returns none, say this park doesn’t have curated routes yet rather than making one up.',
    input_schema: { type: 'object', properties: {} },
  },
]

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
  const args = (input ?? {}) as Record<string, any>
  switch (name) {
    case 'find_itinerary_splits': {
      const state = getOrLoadParkState(ctx.parkId)
      if (!state) throw new Error(`Unknown park "${ctx.parkId}"`)
      return solveItinerary({
        parkId: ctx.parkId,
        dataDir: state.dataDir,
        campsites: state.campsites,
        trails: state.trails,
        stops: args.stops,
        maxDailyMiles: args.maxDailyMiles,
        nights: args.nights,
      })
    }
    case 'get_weather_forecast':
      return getWeatherForecast(args.lat, args.lon)
    case 'get_trail_closures':
      return getTrailClosures(ctx.parkId)
    case 'check_permit_availability':
      return checkPermitAvailability({
        parkId: ctx.parkId,
        siteTokens: args.siteTokens,
        startDate: args.startDate,
        endDate: args.endDate,
      })
    case 'get_known_routes':
      return getKnownRoutes(ctx.parkId)
    default:
      throw new Error(`Unknown tool "${name}"`)
  }
}

/** Short human-readable label for the frontend's tool-activity chips — kept here (not in
 * llm.ts) since it's the one place that already knows every tool's input shape. */
export function describeToolCall(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, any>
  switch (name) {
    case 'find_itinerary_splits':
      return `Checked whether the route fits in ${Array.isArray(args.nights) ? args.nights.join('/') : '?'} night(s)`
    case 'get_weather_forecast':
      return 'Checked the weather forecast'
    case 'get_trail_closures':
      return 'Checked trail conditions/closures'
    case 'check_permit_availability':
      return `Checked permit availability for ${Array.isArray(args.siteTokens) ? args.siteTokens.length : '?'} site(s)`
    case 'get_known_routes':
      return 'Looked up known routes for this park'
    default:
      return `Called ${name}`
  }
}
