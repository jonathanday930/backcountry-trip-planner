// Single source of truth for turning one permit's raw payload into this project's
// campsites.json record shape. Both scrape-permit-campsites.ts (one permit) and
// scrape-all-backcountry-permits.ts (nationwide batch) call this — don't duplicate
// this logic inline in either script again; every bug so far that needed fixing
// twice came from exactly that duplication.
import { buildDivisionDistrictMap, isClosed, startingAreasForDivision, startingAreasForEntrance, todayIso } from "./enrich.js";

export interface RawEntranceFull {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  town?: string;
  division_ids?: string[];
}

export interface RawDivisionFull {
  id: string;
  name: string;
  code: string;
  type: string;
  latitude: number;
  longitude: number;
  district?: string;
}

export interface DerivedRecord {
  id: string;
  name: string;
  // null for a zone-only division with no point in the source data — callers decide
  // whether to keep it as a placeholder for a later zone-polygon fill-in (see
  // build-shenandoah-zones.ts) or drop it immediately (scrape-all-backcountry-permits.ts).
  lat: number | null;
  lon: number | null;
  type: "trailhead" | "designated_campsite" | "corridor_campground" | "at_large";
  context?: string;
  startingAreas?: string[];
  closed?: boolean;
  closedAsOf?: string;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Recreation.gov's entrance list isn't only trailheads — "Issue Station" entries are
 * ranger stations / permit pickup offices, sometimes sharing the exact same name and
 * coordinates as a real trailhead nearby (e.g. Rocky Mountain's "Longs Peak" has both
 * an entrance-type Trailhead AND an Issue Station at the identical point), which then
 * collide as duplicate ids in the output. Every other entrance `type` value seen so far
 * (Trailhead, Parking Area/Lot, Entry Point, Exit Point, Launch Point) is a real place
 * you'd start from and should stay.
 */
function isRealStartingPoint(entranceType: string): boolean {
  return entranceType !== "Issue Station";
}

export function deriveCampsiteRecords(payload: any): DerivedRecord[] {
  const entrances: RawEntranceFull[] = payload.entrances ?? [];
  const divisions: RawDivisionFull[] = Object.values(payload.divisions ?? {});
  const districtMap = buildDivisionDistrictMap([divisions]);

  // Recreation.gov's own source data has real data-entry errors — e.g. Yellowstone's
  // "Mammoth Terraces" entrance carries longitude -110707906 (missing decimal point), and
  // three Zion climbing camps carry longitude -12.9494 (a dropped digit — should be
  // -112.9494). The first is out of range and easy to catch; the second is a perfectly
  // valid longitude, just wrong for Utah, so it can only be caught by checking distance
  // from the permit's own declared location (payload.latitude/longitude), not just range.
  const permitLat = Number(payload.latitude);
  const permitLon = Number(payload.longitude);
  const hasPermitAnchor = Number.isFinite(permitLat) && Number.isFinite(permitLon) && (permitLat !== 0 || permitLon !== 0);
  const MAX_DEGREES_FROM_PERMIT = 3; // generous — Grand Canyon's/North Cascades' dispersed permits span ~1-2.5°
  const isValidCoord = (lat: number, lon: number) => {
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    if (hasPermitAnchor && (Math.abs(lat - permitLat) > MAX_DEGREES_FROM_PERMIT || Math.abs(lon - permitLon) > MAX_DEGREES_FROM_PERMIT)) {
      return false;
    }
    return true;
  };

  const records: DerivedRecord[] = [];

  for (const e of entrances) {
    if (!isRealStartingPoint(e.type)) continue;
    // Entries like a generic "Other" entrance carry no real coordinates and have no
    // downstream fill-in step (unlike at_large divisions, which get one from zone
    // polygon data) — drop rather than emit an unplottable point.
    if (!e.latitude || !e.longitude) continue;
    if (!isValidCoord(e.latitude, e.longitude)) continue;
    const closed = isClosed(e.name);
    records.push({
      id: slugify(e.name),
      name: e.name,
      lat: e.latitude,
      lon: e.longitude,
      type: "trailhead",
      context: e.town || undefined,
      startingAreas: startingAreasForEntrance(e, districtMap),
      ...(closed ? { closed: true, closedAsOf: todayIso() } : {}),
    });
  }

  for (const d of divisions) {
    const hasCoords = Boolean(d.latitude) && Boolean(d.longitude) && isValidCoord(d.latitude, d.longitude);
    // Some parks (e.g. Grand Canyon "At-Large Camping", Mount Rainier "Cross Country Zone" /
    // "Alpine Zone") give a rough reference point for a diffuse camping zone rather than a
    // single reservable site — the name says so explicitly. Trust that over "has coordinates"
    // alone, or these get mislabeled designated_campsite and their long, legitimate distance
    // from any mapped trail looks like a routing bug. Deliberately narrow: "Camp"/"(Group
    // Site)" names (e.g. Camp Muir, Carbon River Camp) are real single fixed locations that
    // just happen to be off-trail (alpine climbing camps, cross-country zones by nature).
    // Zone-only divisions (no valid coords) default to at_large regardless of name.
    const isAtLarge = !hasCoords || /at.large/i.test(d.name) || /\bzone\b/i.test(d.name);
    const closed = isClosed(d.name);
    records.push({
      id: slugify(d.code ? `${d.code}-${d.name}` : d.name),
      name: d.code ? `${d.code} – ${d.name}` : d.name,
      lat: hasCoords ? d.latitude : null,
      lon: hasCoords ? d.longitude : null,
      type: isAtLarge ? "at_large" : "designated_campsite",
      context: d.district || undefined,
      startingAreas: startingAreasForDivision(d),
      ...(closed ? { closed: true, closedAsOf: todayIso() } : {}),
    });
  }

  return records;
}
