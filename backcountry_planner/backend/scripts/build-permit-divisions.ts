// Build the app-facing campsite -> Recreation.gov division mapping from cached raw permit data.
// Usage: npx tsx scripts/build-permit-divisions.ts <dataDir>
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const dataDir = process.argv[2]
if (!dataDir) throw new Error('Usage: npx tsx scripts/build-permit-divisions.ts <dataDir>')

const dir = join(process.cwd(), 'data', dataDir)
const rawEntries: { permitId: string; payload: any }[] = JSON.parse(await readFile(join(dir, 'permits-raw.json'), 'utf8'))
const divisionIdBySlug: Record<string, string> = {}

for (const entry of rawEntries) {
  for (const division of Object.values<any>(entry.payload.divisions ?? {})) {
    const appId = slugify(division.code ? `${division.code}-${division.name}` : division.name)
    if (!appId || division.id == null) continue
    divisionIdBySlug[appId] = String(division.id)
  }
}

await writeFile(join(dir, 'permit-divisions.json'), JSON.stringify({
  permitId: rawEntries.length === 1 ? rawEntries[0].permitId : undefined,
  divisionIdBySlug,
}, null, 2) + '\n')
console.log(`Wrote ${Object.keys(divisionIdBySlug).length} division mappings to ${dataDir}/permit-divisions.json`)
