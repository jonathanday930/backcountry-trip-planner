// Looks up point-to-point distance + elevation gain/loss on Komoot's route
// planner for each leg in test-routes.json, as an independent check against
// our own /api/route output.
//
// Usage: node testing/komoot-lookup.mjs [park id]
//   With a park id, only that park's routes are (re)scraped; results for
//   other parks already in komoot-results.json are left untouched.
// Writes testing/komoot-results.json

import { chromium } from 'playwright'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { lookupLeg, jitter } from './komoot-lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const routesFile = JSON.parse(readFileSync(path.join(__dirname, 'test-routes.json'), 'utf8'))

const parkFilter = process.argv[2]
const routesToRun = parkFilter ? routesFile.routes.filter((r) => r.park === parkFilter) : routesFile.routes

const existingPath = path.join(__dirname, 'komoot-results.json')
const existing = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) : []

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const newResults = []
for (const route of routesToRun) {
  console.log(`\n${route.park} / ${route.name}`)
  const legs = []
  for (let i = 0; i < route.stops.length - 1; i++) {
    const from = route.stops[i]
    const to = route.stops[i + 1]
    process.stdout.write(`  leg ${i + 1}: ${from.name} -> ${to.name} ... `)
    try {
      let stats = await lookupLeg(page, from, to)
      // A null-stat result usually means Komoot's stat panel never stabilized in time (slow
      // route computation, or a waypoint suggestion click that didn't land) rather than a real
      // "no route" - a fresh page + retry clears this more often than not.
      let attempts = 1
      while ((!stats || stats.distance == null || stats.elevationGain == null || stats.elevationLoss == null) && attempts < 3) {
        attempts++
        await page.waitForTimeout(jitter(1000, 2000))
        stats = await lookupLeg(page, from, to)
      }
      legs.push({ from: from.name, to: to.name, komoot: stats })
      console.log(JSON.stringify(stats) + (attempts > 1 ? ` (after ${attempts} attempts)` : ''))
    } catch (err) {
      console.log('FAILED: ' + err.message)
      legs.push({ from: from.name, to: to.name, komoot: null, error: err.message })
    }
    await page.waitForTimeout(jitter(300, 900))
  }
  newResults.push({ park: route.park, name: route.name, legs })
}

await browser.close()

// merge: replace any existing entry with the same park+name, keep everything else
const merged = existing.filter((r) => !newResults.some((n) => n.park === r.park && n.name === r.name))
merged.push(...newResults)

writeFileSync(existingPath, JSON.stringify(merged, null, 2))
console.log('\nWrote testing/komoot-results.json')
