// Shared helpers for deriving startingAreas + closed status from a permit's raw
// payload. Used by both scrapers (for future scrapes) and the retroactive
// enrichment script (for already-built parks, using their cached permits-raw.json).

export interface RawEntrance {
  id: string;
  name: string;
  division_ids?: string[];
}

export interface RawDivision {
  id: string;
  name: string;
  district?: string;
}

const BLANK_DISTRICTS = new Set(["", "undesignated"]);

function isRealDistrict(district: string | undefined): district is string {
  return Boolean(district) && !BLANK_DISTRICTS.has(district!.trim().toLowerCase());
}

/** Maps division id -> its Starting Area (district), across one or more merged permits. */
export function buildDivisionDistrictMap(divisionsPerPermit: RawDivision[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const divisions of divisionsPerPermit) {
    for (const d of divisions) {
      if (isRealDistrict(d.district)) map.set(d.id, d.district);
    }
  }
  return map;
}

/** A trailhead/entrance can feed into divisions across more than one Starting Area. */
export function startingAreasForEntrance(entrance: RawEntrance, districtMap: Map<string, string>): string[] {
  const areas = new Set<string>();
  for (const divId of entrance.division_ids ?? []) {
    const district = districtMap.get(divId);
    if (district) areas.add(district);
  }
  return [...areas].sort();
}

/** A division/campsite has exactly one native Starting Area (its own district field). */
export function startingAreasForDivision(division: RawDivision): string[] {
  return isRealDistrict(division.district) ? [division.district] : [];
}

// Recreation.gov names sometimes describe *when an alternate option is used*, not that
// the item itself is closed — e.g. Grand Canyon's "NCG - (when N.Rim Closed) North Rim
// Campground" is the campground you'd use precisely when the (different) N. Rim road is
// closed. Excluding that shape avoids a false "closed" flag on a perfectly open site.
const CLOSED_FALSE_POSITIVE = /\(when\b[^)]*closed/i;

export function isClosed(name: string): boolean {
  return /closed/i.test(name) && !CLOSED_FALSE_POSITIVE.test(name);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
