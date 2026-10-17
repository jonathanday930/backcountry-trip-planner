// Merges komoot-results.json and ours-results.json into one table per
// route, with delta/percent-off columns for distance and elevation gain/loss.
//
// Usage: node testing/build-report.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const komoot = JSON.parse(readFileSync(path.join(__dirname, 'komoot-results.json'), 'utf8'))
const ours = JSON.parse(readFileSync(path.join(__dirname, 'ours-results.json'), 'utf8'))

function toMiles(stat) {
  if (!stat) return null
  const meters = stat.unit === 'km' ? stat.value * 1000 : stat.value
  return meters / 1609.34
}
function toFeet(stat) {
  if (!stat) return null
  return stat.value * 3.28084
}
function pctOff(ours, komoot) {
  if (ours == null || komoot == null || komoot === 0) return '-'
  const pct = ((ours - komoot) / komoot) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

let md = '# Route comparison: our engine vs Komoot\n\n'
md += 'Distances in miles, elevation gain/loss in feet. % off = (ours - Komoot) / Komoot.\n\n'

for (const route of komoot) {
  md += `## ${route.park} — ${route.name}\n\n`
  md += '| Leg | Komoot dist | Ours dist | Dist % off | Komoot +/- | Ours +/- | Gain % off | Loss % off |\n'
  md += '|---|---|---|---|---|---|---|---|\n'

  const ourRoute = ours.find((r) => r.park === route.park && r.name === route.name)

  route.legs.forEach((leg, i) => {
    const label = `${leg.from} → ${leg.to}`
    const ourLeg = ourRoute?.legs[i]

    if (!leg.komoot || leg.komoot.distance == null || leg.komoot.elevationGain == null || leg.komoot.elevationLoss == null) {
      md += `| ${label} | FAILED (Komoot) | - | - | - | - | - | - |\n`
      return
    }
    if (!ourLeg?.ours) {
      md += `| ${label} | ${toMiles(leg.komoot.distance).toFixed(2)} | **NO ROUTE (ours)** | - | +${toFeet(leg.komoot.elevationGain).toFixed(0)} / -${toFeet(leg.komoot.elevationLoss).toFixed(0)} | - | - | - |\n`
      return
    }

    const kDist = toMiles(leg.komoot.distance)
    const kGain = toFeet(leg.komoot.elevationGain)
    const kLoss = toFeet(leg.komoot.elevationLoss)
    const oDist = ourLeg.ours.distanceMiles
    const oGain = ourLeg.ours.elevationGainFt
    const oLoss = ourLeg.ours.elevationLossFt

    md += `| ${label} | ${kDist.toFixed(2)} | ${oDist.toFixed(2)} | ${pctOff(oDist, kDist)} | +${kGain.toFixed(0)} / -${kLoss.toFixed(0)} | +${oGain.toFixed(0)} / -${oLoss.toFixed(0)} | ${pctOff(oGain, kGain)} | ${pctOff(oLoss, kLoss)} |\n`
  })
  md += '\n'
}

writeFileSync(path.join(__dirname, 'comparison-report.md'), md)
console.log('Wrote testing/comparison-report.md')
