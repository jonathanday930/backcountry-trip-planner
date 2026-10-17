// Computes pass/fail totals from komoot-results.json + ours-results.json,
// applying the same noise floors used throughout the accuracy-validation
// process (see README.md's "Reading the results" section): a leg is only
// scored on distance if Komoot's own distance is >= 0.3mi, and only scored
// on gain/loss if Komoot's own value for that direction is >= 50m (164ft).
// A leg below the floor on a given metric is excluded from that metric's
// scoring, not counted as a pass or a fail.
//
// Usage: node testing/summarize-report.mjs
// Run this after build-report.mjs; it reads the same two source files
// (not comparison-report.md) so its numbers can never drift from the report.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const komoot = JSON.parse(readFileSync(path.join(__dirname, 'komoot-results.json'), 'utf8'))
const ours = JSON.parse(readFileSync(path.join(__dirname, 'ours-results.json'), 'utf8'))

const DIST_FLOOR_MI = 0.3
const ELEV_FLOOR_FT = 164 // ~50m

function toMiles(stat) {
  if (!stat) return null
  const meters = stat.unit === 'km' ? stat.value * 1000 : stat.value
  return meters / 1609.34
}
function toFeet(stat) {
  if (!stat) return null
  return stat.value * 3.28084
}
function pct(ourVal, komootVal) {
  return ((ourVal - komootVal) / komootVal) * 100
}

let total = 0
let failed = 0 // no komoot data, or ours found no route
let clean = 0 // every scored metric on this leg is within 10%
const failingLegs = []

for (const route of komoot) {
  const ourRoute = ours.find((r) => r.park === route.park && r.name === route.name)
  route.legs.forEach((leg, i) => {
    total++
    const label = `[${route.park} — ${route.name}] ${leg.from} → ${leg.to}`
    const ourLeg = ourRoute?.legs[i]

    if (!leg.komoot || leg.komoot.distance == null || leg.komoot.elevationGain == null || leg.komoot.elevationLoss == null) {
      failed++
      failingLegs.push(`${label}: FAILED (no Komoot data)`)
      return
    }
    if (!ourLeg?.ours) {
      failed++
      failingLegs.push(`${label}: FAILED (our engine found no route)`)
      return
    }

    const kDist = toMiles(leg.komoot.distance)
    const kGain = toFeet(leg.komoot.elevationGain)
    const kLoss = toFeet(leg.komoot.elevationLoss)
    const oDist = ourLeg.ours.distanceMiles
    const oGain = ourLeg.ours.elevationGainFt
    const oLoss = ourLeg.ours.elevationLossFt

    const problems = []
    if (kDist >= DIST_FLOOR_MI) {
      const p = pct(oDist, kDist)
      if (Math.abs(p) > 10) problems.push(`distance ${p >= 0 ? '+' : ''}${p.toFixed(1)}% (komoot ${kDist.toFixed(2)}mi, ours ${oDist.toFixed(2)}mi)`)
    }
    if (kGain >= ELEV_FLOOR_FT) {
      const p = pct(oGain, kGain)
      if (Math.abs(p) > 10) problems.push(`gain ${p >= 0 ? '+' : ''}${p.toFixed(1)}% (komoot +${kGain.toFixed(0)}ft, ours +${oGain.toFixed(0)}ft)`)
    }
    if (kLoss >= ELEV_FLOOR_FT) {
      const p = pct(oLoss, kLoss)
      if (Math.abs(p) > 10) problems.push(`loss ${p >= 0 ? '+' : ''}${p.toFixed(1)}% (komoot -${kLoss.toFixed(0)}ft, ours -${oLoss.toFixed(0)}ft)`)
    }

    if (problems.length === 0) {
      clean++
    } else {
      failingLegs.push(`${label}: ${problems.join(', ')}`)
    }
  })
}

console.log(`Total legs: ${total}`)
console.log(`Failed (no Komoot data or no route found): ${failed}`)
console.log(`Clean (all scored metrics within 10%, or below the noise floor): ${clean}`)
console.log(`Scored legs: ${total - failed}, of which ${clean} clean (${((clean / (total - failed)) * 100).toFixed(1)}%)`)

if (failingLegs.length > 0) {
  console.log(`\n${failingLegs.length} legs with an issue:`)
  for (const f of failingLegs) console.log(`  ${f}`)
}
