// Replace the known-bad Recreation.gov Olympic wilderness campsite coordinates with the
// National Park Service's public ArcGIS primitive-campground layer coordinates.
// Usage: npx tsx scripts/enrich-olympic-campsites.ts
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dir = join(process.cwd(), 'data', 'olympic-national-park')
const serviceUrl = 'https://services7.arcgis.com/2hYXmwteFLemN5bW/arcgis/rest/services/Olympic_National_Park__AA__WFL1/FeatureServer'

function key(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\b(campsite|campground|group site|group sites|stock site|stock camp)\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const trailheadAliases: Record<string, string> = {
  dosewallipsroad: 'dosewallipsroadwashout',
  upperbigquilceneusfs: 'bigquilcene',
  hohbogachiel: 'hohbogachielsouthsnyderjacksontrail',
  elwhacampgroundcascaderock: 'elwhacampground',
  upperdungenessusfs: 'upperdungenesstubalcain',
  bouldercreek: 'bouldercreek',
  madisonfalls: 'madisonfalls',
  auroratrail: 'auroraridge',
  elwhahurricanehill: 'elwhatohurricane',
  hurricanevcwinter: 'bigmeadowhurricanecvcwinter',
  snowcreekusfs: 'upperdungenesstubalcain',
  gravescreek: 'gravescreekrangerstation',
  ruggedridgeusfs: 'ruggedridgenorthsnyderjacksontrail',
  hohvisitorcenter: 'hohrangerstation',
  bogachiel: 'bogachieltrail',
  tubalcain: 'upperdungenesstubalcain',
  solduc: 'solductrail',
}

const params = new URLSearchParams({
  where: '1=1',
  outFields: 'POINAME,POIALTNAME',
  returnGeometry: 'true',
  outSR: '4326',
  f: 'geojson',
})
const response = await fetch(`${serviceUrl}/18/query?${params}`)
if (!response.ok) throw new Error(`ArcGIS request failed: ${response.status}`)
const layer = await response.json() as { features?: { properties?: { POINAME?: string; POIALTNAME?: string }; geometry?: { coordinates?: [number, number] } }[] }

const coordinates = new Map<string, [number, number]>()
for (const feature of layer.features ?? []) {
  const names = [feature.properties?.POINAME, feature.properties?.POIALTNAME].filter(Boolean) as string[]
  const point = feature.geometry?.coordinates
  if (!point || point.length < 2) continue
  for (const name of names) coordinates.set(key(name), [point[1], point[0]])
}

const trailheadParams = new URLSearchParams({
  where: '1=1',
  outFields: 'POINAME,POIALTNAME',
  returnGeometry: 'true',
  outSR: '4326',
  f: 'geojson',
})
const trailheadResponse = await fetch(`${serviceUrl}/67/query?${trailheadParams}`)
if (!trailheadResponse.ok) throw new Error(`ArcGIS trailhead request failed: ${trailheadResponse.status}`)
const trailheadLayer = await trailheadResponse.json() as { features?: { properties?: { POINAME?: string; POIALTNAME?: string }; geometry?: { coordinates?: [number, number] } }[] }
const trailheadCoordinates = new Map<string, [number, number]>()
for (const feature of trailheadLayer.features ?? []) {
  const names = [feature.properties?.POINAME, feature.properties?.POIALTNAME].filter(Boolean) as string[]
  const point = feature.geometry?.coordinates
  if (!point || point.length < 2) continue
  for (const name of names) trailheadCoordinates.set(key(name), [point[1], point[0]])
}

const allCampsites = JSON.parse(await readFile(join(dir, 'campsites.json'), 'utf8')) as { id: string; name: string; lat: number | null; lon: number | null; type?: string; context?: string }[]
// Trailheads in this file are enrichment output from an earlier run. Rebuild that portion
// deterministically so changing an alias cannot leave stale duplicate IDs behind.
const campsites = allCampsites.filter((c) => c.type !== 'trailhead')
const unmatched: string[] = []
let matched = 0
for (const campsite of campsites) {
  const point = coordinates.get(key(campsite.name))
  if (!point) {
    unmatched.push(`${campsite.id} (${campsite.name})`)
    continue
  }
  campsite.lat = point[0]
  campsite.lon = point[1]
  matched++
}

const rawEntries = JSON.parse(await readFile(join(dir, 'permits-raw.json'), 'utf8')) as { payload: { entrances?: { name: string }[] } }[]
const existingIds = new Set(campsites.map((c) => c.id))
const unmatchedTrailheads: string[] = []
const initialCount = campsites.length
for (const entrance of rawEntries.flatMap((entry) => entry.payload.entrances ?? [])) {
  const entranceKey = key(entrance.name.replace(/\bTH\b/gi, ''))
  const point = trailheadCoordinates.get(trailheadAliases[entranceKey] ?? entranceKey)
  if (!point) {
    unmatchedTrailheads.push(entrance.name)
    continue
  }
  const id = slugify(entrance.name.replace(/\bTH\b/gi, ''))
  if (existingIds.has(id)) continue
  campsites.push({ id, name: entrance.name, lat: point[0], lon: point[1], type: 'trailhead' })
  existingIds.add(id)
}

await writeFile(join(dir, 'campsites.json'), JSON.stringify(campsites, null, 2) + '\n')
console.log(`Matched ${matched}/${initialCount} Olympic campsite records to NPS ArcGIS coordinates.`)
if (unmatched.length) {
  console.log(`Unmatched records (${unmatched.length}):`)
  for (const item of unmatched) console.log(`  ${item}`)
}
console.log(`Added ${campsites.length - initialCount} trailheads from the NPS ArcGIS trailhead layer.`)
if (unmatchedTrailheads.length) {
  console.log(`Unmatched trailheads (${unmatchedTrailheads.length}):`)
  for (const item of unmatchedTrailheads) console.log(`  ${item}`)
}
