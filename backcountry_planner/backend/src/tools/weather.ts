// api.weather.gov, same native-fetch + timeout + retry shape as elevation.ts's USGS EPQS calls.
// No API key needed, but NWS requires a descriptive User-Agent identifying the app.
const USER_AGENT = 'backcountry-trip-planner (https://backcountry-trip-planner.fly.dev)'
const MAX_RETRIES = 2

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`weather.gov returned ${res.status} for ${url}`)
      return await res.json()
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
    }
  }
  throw new Error('unreachable')
}

export interface ForecastPeriod {
  name: string
  startTime: string
  endTime: string
  temperatureF: number
  shortForecast: string
  detailedForecast: string
  windSpeed: string
  probabilityOfPrecipitationPercent: number | null
}

export interface WeatherForecastResult {
  lat: number
  lon: number
  periods: ForecastPeriod[]
}

/** Two-step NWS flow: /points resolves a lat/lon to its forecast-grid endpoint, which is only
 * then queryable for the actual forecast — there's no single-call shortcut. Bounded to the first
 * 6 periods (~3 days) to keep the tool result small; NWS point forecasts don't extend reliably
 * past 7 days anyway. */
export async function getWeatherForecast(lat: number, lon: number): Promise<WeatherForecastResult> {
  const points = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`)
  const forecastUrl = points?.properties?.forecast
  if (!forecastUrl) throw new Error(`No NWS forecast grid found for ${lat},${lon} — likely outside the US`)
  const forecast = await fetchJson(forecastUrl)
  const periods = (forecast?.properties?.periods ?? []).slice(0, 6).map((p: any) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    temperatureF: p.temperature,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
    windSpeed: p.windSpeed,
    probabilityOfPrecipitationPercent: p.probabilityOfPrecipitation?.value ?? null,
  }))
  return { lat, lon, periods }
}
