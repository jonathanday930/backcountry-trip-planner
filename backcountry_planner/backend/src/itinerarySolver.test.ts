import { describe, it, expect } from 'vitest'
import { solveItinerary } from './itinerarySolver.js'
import { getOrLoadParkState } from './parkState.js'

// Uses Glacier's real, checked-in trail/campsite data (no mocking) — this is the same corridor
// validated by hand against `/api/route` this session (St. Mary to Two Medicine via Triple Divide
// Pass), so the expected numbers below are real, not invented.
describe('solveItinerary', () => {
  const stops = [
    'ree-red-eagle-trail',
    'ref-red-eagle-lake-foot',
    'atl-atlantic-creek-no-campfires',
    'old-oldman-lake-no-campfires',
    'tne-two-medicine-north-shore-trail',
  ]

  it('finds a 3-night split using every intermediate stop when the cap comfortably allows it', async () => {
    const state = getOrLoadParkState('glacier')!
    const result = await solveItinerary({
      parkId: 'glacier',
      dataDir: state.dataDir,
      campsites: state.campsites,
      trails: state.trails,
      stops,
      maxDailyMiles: 17,
      nights: [3],
    })

    expect(result.legStats).toHaveLength(4)
    // Real distances, cross-checked against /api/route this session.
    expect(result.legStats[0].distanceMiles).toBeCloseTo(7.84, 1)
    expect(result.legStats[1].distanceMiles).toBeCloseTo(11.36, 1)
    expect(result.legStats[2].distanceMiles).toBeCloseTo(7.62, 1)
    expect(result.legStats[3].distanceMiles).toBeCloseTo(6.34, 1)

    const threeNight = result.results.find((r) => r.nights === 3)
    expect(threeNight?.feasible).toBe(true)
    expect(threeNight?.split?.campedAt).toEqual([
      'ref-red-eagle-lake-foot',
      'atl-atlantic-creek-no-campfires',
      'old-oldman-lake-no-campfires',
      'tne-two-medicine-north-shore-trail',
    ])
    // Worst day is the Red Eagle -> Atlantic Creek leg over Triple Divide Pass.
    expect(threeNight?.split?.worstDayMiles).toBeCloseTo(11.36, 1)
  })

  it('collapses stops onto fewer, longer days when only 2 nights are requested', async () => {
    const state = getOrLoadParkState('glacier')!
    const result = await solveItinerary({
      parkId: 'glacier',
      dataDir: state.dataDir,
      campsites: state.campsites,
      trails: state.trails,
      stops,
      maxDailyMiles: 17,
      nights: [2],
    })

    const twoNight = result.results.find((r) => r.nights === 2)
    expect(twoNight?.feasible).toBe(true)
    // Only 2 of the 3 intermediate stops get used as camps.
    expect(twoNight?.split?.campedAt).toHaveLength(3)
  })

  it('reports infeasible with a helpful signal when the cap is too tight for the requested nights', async () => {
    const state = getOrLoadParkState('glacier')!
    const result = await solveItinerary({
      parkId: 'glacier',
      dataDir: state.dataDir,
      campsites: state.campsites,
      trails: state.trails,
      stops,
      maxDailyMiles: 5, // no single leg on this corridor is anywhere near this short
      nights: [3],
    })

    const threeNight = result.results.find((r) => r.nights === 3)
    expect(threeNight?.feasible).toBe(false)
    expect(threeNight?.bestPossibleWorstDayMiles).toBeGreaterThan(5)
  })

  it('rejects a night count that exceeds the number of available intermediate stops', async () => {
    const state = getOrLoadParkState('glacier')!
    const result = await solveItinerary({
      parkId: 'glacier',
      dataDir: state.dataDir,
      campsites: state.campsites,
      trails: state.trails,
      stops,
      maxDailyMiles: 17,
      nights: [10],
    })

    const tenNight = result.results.find((r) => r.nights === 10)
    expect(tenNight?.feasible).toBe(false)
  })
})
