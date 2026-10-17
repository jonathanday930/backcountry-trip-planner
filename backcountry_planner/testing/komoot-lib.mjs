// Shared logic for looking up point-to-point distance + elevation gain/loss
// on Komoot's route planner.

export function jitter(min = 200, max = 900) {
  return min + Math.random() * (max - min)
}

async function dismissOverlays(page) {
  const cookieBtn = page.locator('[data-test-id="gdpr-banner-accept"]')
  if (await cookieBtn.isVisible().catch(() => false)) {
    await cookieBtn.click()
    await page.waitForTimeout(jitter())
  }
  const gotIt = page.getByText('Got it', { exact: true })
  if (await gotIt.isVisible().catch(() => false)) {
    await gotIt.click()
    await page.waitForTimeout(jitter())
  }
}

async function selectHikingSport(page) {
  const sportBtn = page.getByText('Select a sport', { exact: true })
  if (await sportBtn.isVisible().catch(() => false)) {
    await sportBtn.click()
    await page.waitForTimeout(jitter())
    await page.getByText('Hiking', { exact: true }).first().click()
    await page.waitForTimeout(jitter())
  }
  await dismissOverlays(page)
}

async function setWaypoint(page, buttonText, lat, lon) {
  await page.getByText(buttonText, { exact: true }).click()
  await page.waitForTimeout(jitter())
  const searchInput = page.getByPlaceholder('Search for place or address')
  await searchInput.fill(`${lat}, ${lon}`)
  await page.waitForTimeout(jitter(800, 1500))
  // Komoot has rendered coordinate suggestions both with and without a space after
  // the comma. Keep the coordinate match tolerant, then fall back to Enter when
  // the suggestion list is omitted for a remote/offline point.
  const coordinateOption = page.locator('text=/^-?\\d+\\.\\d+,\\s*-?\\d+\\.\\d+$/').first()
  try {
    await coordinateOption.waitFor({ state: 'visible', timeout: 8000 })
    await coordinateOption.click()
  } catch {
    await searchInput.press('Enter')
  }
  await page.waitForTimeout(jitter())
}

export function parseStats(bodyText) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean)
  const grab = (label) => {
    const idx = lines.indexOf(label)
    if (idx < 2) return null
    const unit = lines[idx - 1]
    // Komoot renders thousands with a comma (e.g. "1,550") - strip it before parsing.
    const value = parseFloat(lines[idx - 2].replace(/,/g, ''))
    return Number.isNaN(value) ? null : { value, unit }
  }
  return {
    distance: grab('Distance'),
    elevationGain: grab('Elevation gain'),
    elevationLoss: grab('Elevation loss'),
  }
}

function statsEqual(a, b) {
  if (!a || !b) return false
  const same = (x, y) => x?.value === y?.value && x?.unit === y?.unit
  return same(a.distance, b.distance) && same(a.elevationGain, b.elevationGain) && same(a.elevationLoss, b.elevationLoss)
}

// Komoot animates these stat numbers counting up after a route is (re)computed,
// so a fixed wait can catch them mid-count on longer/bigger routes. Poll until
// two consecutive reads agree (or give up after ~10s and use the last read).
export async function waitForStableStats(page, { intervalMs = 500, timeoutMs = 10000 } = {}) {
  const start = Date.now()
  let prev = null
  while (Date.now() - start < timeoutMs) {
    const bodyText = await page.locator('body').innerText()
    const current = parseStats(bodyText)
    if (current.distance && current.elevationGain && current.elevationLoss && statsEqual(current, prev)) {
      return current
    }
    prev = current
    await page.waitForTimeout(intervalMs)
  }
  return prev
}

export async function lookupLeg(page, from, to) {
  await page.goto('https://www.komoot.com/plan', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(jitter(800, 1500))
  await dismissOverlays(page)
  await selectHikingSport(page)

  await setWaypoint(page, 'Enter Starting Point', from.lat, from.lon)
  await setWaypoint(page, 'Enter Destination', to.lat, to.lon)
  await page.waitForTimeout(jitter(1000, 1500))

  return waitForStableStats(page)
}
