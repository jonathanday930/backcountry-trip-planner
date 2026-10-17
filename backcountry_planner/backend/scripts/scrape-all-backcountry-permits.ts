// Finds every backcountry/wilderness permit entity on Recreation.gov (nationwide,
// no geo bias) and pulls its trailheads/entrances + point-coordinate campsites.
// Zone-only areas (no lat/lon in the permit API, e.g. "camp anywhere in this
// zone" areas) are skipped for now — that needs real GIS polygon data per park,
// which is a separate follow-up (see build-shenandoah-zones.ts for the pattern).
//
// Usage: npx tsx scripts/scrape-all-backcountry-permits.ts
//
// No login required — both the search and permitcontent endpoints are public.
// NOTE: this nationwide search doesn't surface every real permit — Rocky
// Mountain National Park's own permit didn't score highly enough for the
// query text used and was missed entirely. If a park you expect isn't in the
// output, search for it by name directly and use scrape-permit-campsites.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveCampsiteRecords, type DerivedRecord } from "./lib/deriveRecords.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "data");

interface SearchResult {
  entity_id: string;
  name: string;
  entity_type: string;
  state_code?: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function findAllPermits(): Promise<SearchResult[]> {
  const url =
    "https://www.recreation.gov/api/search/geo?q=backcountry%20permits&radius=3000&size=200" +
    "&fq=entity_type%3Apermit&sort=score&start=0&lat=39.8283&lng=-98.5795";
  const body = await fetchJson(url);
  return body.results;
}

interface RawEntry {
  permitId: string;
  permitName: string;
  payload: unknown;
}

async function main() {
  const permits = await findAllPermits();
  console.log(`Found ${permits.length} permit entities nationwide.\n`);

  const summary: { park: string; permit: string; trailheads: number; campsites: number }[] = [];

  // Accumulated fully in memory across the whole run (rather than read-merged
  // against whatever's already on disk) so each run is a clean, reproducible
  // regeneration — a record dropped this run (e.g. a coordinate sanity check
  // that newly rejects a bad point) actually disappears, instead of persisting
  // forever from a stale previous write.
  const campsitesByPark = new Map<string, Map<string, DerivedRecord>>();
  const rawByPark = new Map<string, Map<string, RawEntry>>();

  for (const permit of permits) {
    let payload: any;
    try {
      const res = await fetchJson(`https://www.recreation.gov/api/permitcontent/${permit.entity_id}`);
      payload = res.payload;
    } catch (err) {
      console.error(`Skipping ${permit.name} (${permit.entity_id}): ${(err as Error).message}`);
      continue;
    }

    const parkName: string = payload.recarea_name || payload.name || permit.name;
    const parkSlug = slugify(parkName);

    if (!rawByPark.has(parkSlug)) rawByPark.set(parkSlug, new Map());
    rawByPark.get(parkSlug)!.set(permit.entity_id, { permitId: permit.entity_id, permitName: permit.name, payload });

    // Batch mode wants only immediately-plottable records — drop zone-only (null-coord)
    // divisions rather than keep them as placeholders (contrast scrape-permit-campsites.ts,
    // which keeps them for an optional later zone-polygon fill-in).
    const records = deriveCampsiteRecords(payload).filter(
      (r): r is DerivedRecord & { lat: number; lon: number } => r.lat !== null && r.lon !== null,
    );

    if (records.length === 0) {
      console.log(`(no plottable data) ${permit.name}`);
      await sleep(300);
      continue;
    }

    // Merge with any records already accumulated for this park from an earlier
    // permit in this same run (e.g. Zion has 3 separate permits), de-duping by id.
    if (!campsitesByPark.has(parkSlug)) campsitesByPark.set(parkSlug, new Map());
    const byId = campsitesByPark.get(parkSlug)!;
    for (const r of records) byId.set(r.id, r);

    const trailheadCount = records.filter((r) => r.type === "trailhead").length;
    const campsiteCount = records.filter((r) => r.type === "designated_campsite").length;
    summary.push({ park: parkSlug, permit: permit.name, trailheads: trailheadCount, campsites: campsiteCount });
    console.log(
      `${parkSlug}: +${trailheadCount} trailheads, +${campsiteCount} campsites (from "${permit.name}") -> ${byId.size} total`,
    );

    await sleep(300); // be polite to the API
  }

  for (const [parkSlug, rawEntries] of rawByPark) {
    const outDir = join(OUT_DIR, parkSlug);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "permits-raw.json"), JSON.stringify([...rawEntries.values()], null, 2) + "\n");

    const campsites = campsitesByPark.get(parkSlug);
    if (campsites) {
      await writeFile(join(outDir, "campsites.json"), JSON.stringify([...campsites.values()], null, 2) + "\n");
    }
  }

  console.log(`\nDone. ${summary.length} permits yielded plottable data.`);
}

main();
