// Queries our own /api/route for every leg in test-routes.json (backend
// dev server must already be running on :3001).
//
// Usage: node testing/fetch-ours.mjs [park id]
//   With a park id, only that park's routes are (re)queried; results for
//   other parks already in ours-results.json are left untouched.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routesFile = JSON.parse(readFileSync(path.join(__dirname, 'test-routes.json'), 'utf8'))

const parkFilter = process.argv[2]
const routesToRun = parkFilter ? routesFile.routes.filter((r) => r.park === parkFilter) : routesFile.routes

const existingPath = path.join(__dirname, 'ours-results.json')
const existing = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) : []

const newResults = []
for (const route of routesToRun) {
  console.log(`\n${route.park} / ${route.name}`)
  const legs = []
  for (let i = 0; i < route.stops.length - 1; i++) {
    const from = route.stops[i]
    const to = route.stops[i + 1]
    const url = `http://localhost:3001/api/route?park=${route.park}&stops=${from.id}|${to.id}`
    const res = await fetch(url)
    if (!res.ok) {
      console.log(`  leg ${i + 1}: ${from.name} -> ${to.name} ... FAILED ${res.status}`)
      legs.push({ from: from.name, to: to.name, ours: null })
      continue
    }
    const data = await res.json()
    console.log(`  leg ${i + 1}: ${from.name} -> ${to.name} ... ${data.distanceMiles.toFixed(2)} mi, +${Math.round(data.elevationGainFt)}/-${Math.round(data.elevationLossFt)} ft`)
    legs.push({
      from: from.name,
      to: to.name,
      ours: {
        distanceMiles: data.distanceMiles,
        elevationGainFt: data.elevationGainFt,
        elevationLossFt: data.elevationLossFt,
      },
    })
  }
  newResults.push({ park: route.park, name: route.name, legs })
}

const merged = existing.filter((r) => !newResults.some((n) => n.park === r.park && n.name === r.name))
merged.push(...newResults)

writeFileSync(existingPath, JSON.stringify(merged, null, 2))
console.log('\nWrote testing/ours-results.json')
