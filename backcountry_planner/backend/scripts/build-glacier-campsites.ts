// One-off: Glacier's Recreation.gov permit payload (data/glacier/permits-raw.json)
// carries zero lat/lon for every entrance and division — unlike every other park
// scraped so far, Recreation.gov never populated coordinates for this permit. Two
// problems to solve, both handled here rather than in the generic scrapers:
//
// 1. Which of Glacier's 213 divisions are real, public, bookable backcountry
//    campsites? Recreation.gov's own payload already answers this: 148 of them
//    (ranger stations, cabins, fire lookouts, frontcountry "Auto CG - Winter"
//    listings, numbered river-float "Zone N" areas, CDT stock hitch-rails,
//    "Administrative Site"s, a "Placeholder") are flagged `is_hidden: true` in the
//    source data. The other 65 (`is_hidden: false`) are the actual named,
//    code-prefixed backcountry camps ("FIF - Fifty Mountain", "GUN - Gunsight
//    Lake", ...) — use that flag directly rather than guessing from name patterns.
// 2. Where are they? OSM already carries most of Glacier's backcountry campsites
//    as `tourism=camp_site` nodes tagged `source=NPS` (and named trailheads as
//    `highway=trailhead`) — this matches those in by normalized name.
//
// Run: npx tsx scripts/build-glacier-campsites.ts
// (re-run after scripts/scrape-permit-campsites.ts 4675321 glacier if the permit
// payload is ever re-scraped; it regenerates data/glacier/campsites.json from
// data/glacier/permits-raw.json + a live Overpass query, no manual state.)
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slugify, type DerivedRecord } from "./lib/deriveRecords.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const dataDir = join(__dirname, "..", "data", "glacier");
// Generous box around the park (includes the Canadian side / Waterton Lakes NP,
// since a couple of Glacier's own entrances sit right on the border) — matching
// is by name, not proximity, so extra area just means extra unused candidates.
const BBOX = "48.20,-114.70,49.05,-113.10";

interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

// Same rationale as build-park-network.ts: Node's fetch (undici) trips a 406 on
// overpass-api.de's Apache front end that plain curl doesn't.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOverpass(query: string): Promise<OverpassNode[]> {
  const marker = "\nHTTP_STATUS:%{http_code}";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { stdout } = await execFileAsync(
      "curl",
      ["-s", "-m", "90", "https://lz4.overpass-api.de/api/interpreter", "--data-urlencode", `data=${query}`, "-w", marker],
      { maxBuffer: 1024 * 1024 * 50 },
    );
    const splitAt = stdout.lastIndexOf("\nHTTP_STATUS:");
    const body = stdout.slice(0, splitAt);
    const status = stdout.slice(splitAt + "\nHTTP_STATUS:".length).trim();
    if (status === "200") return JSON.parse(body).elements;
    // Overpass rate-limits back-to-back requests from the same IP (429) — back off and retry
    // rather than treat it as a real failure.
    if ((status === "429" || status === "504") && attempt < 5) {
      await sleep(attempt * 15_000);
      continue;
    }
    throw new Error(`Overpass request failed: HTTP ${status}\n${body.slice(0, 500)}`);
  }
  throw new Error("unreachable");
}

const NOISE_WORDS = new Set(["camp", "campsite", "campground", "shelter", "shelters", "site", "sites", "no", "campfires", "the", "in", "2026"]);

function normTokens(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !NOISE_WORDS.has(t))
    .sort()
    .join(" ");
}

// Recreation.gov division/entrance names are "CODE - Real Name" or "CODE – Real
// Name"; strip the code prefix before matching against OSM's plain names.
function stripCode(name: string): string {
  const m = name.match(/^[A-Za-z]+\s*[-–]\s*(.+)$/);
  return m ? m[1] : name;
}

// A handful of real backcountry campsites whose Recreation.gov name doesn't
// normalize to an exact token match against OSM's name for the same place —
// confirmed by hand, one at a time (see README's warning against fuzzy-matching
// names generally: it risks false-positive merges, so every one of these was
// checked against the map, not auto-matched).
const CAMPSITE_ALIASES: Record<string, string> = {
  "Flattop (No Campfires)": "Flattop Mountain Campground",
  Adair: "Adir",
  "Lower Nyack": "Lower Nyack Creek",
  "Upper Nyack": "Upper Nyack Creek",
  "Logging Lake": "Foot Logging Lake",
};

// Entrances confirmed by hand against OSM's highway=trailhead nodes (exact or
// unambiguous partial name match, e.g. "Bowman Lake Foot" -> "Bowman Lake
// Trailhead"). Left out: entrances that only loosely resemble a nearby hamlet,
// ranger station, or mountain pass rather than an actual named trailhead node —
// better to drop those than guess at an approximate, possibly-wrong snap point.
const ENTRANCE_ALIASES: Record<string, string> = {
  "Akokala Creek": "Akokala Creek Trailhead",
  "Apikuni Falls": "Apikuni Trailhead",
  "Baring Creek (Sunrift Gorge)": "Baring Creek Trailhead",
  "Bowman Lake Foot": "Bowman Lake Trailhead",
  "Belly River Trail": "Belly River Trailhead",
  "Cut Bank Creek": "Cut Bank Trailhead",
  "Camas Creek": "Camas Creek Trailhead",
  "Coal Creek": "Fielding / Coal Creek Trailhead",
  "Headquarters Boundary Trail": "Boundary Trailhead",
  "Iceberg/Ptarmigan Trail": "Iceberg Ptarmigan Trailhead",
  "Kintla Lake": "Kintla Lake Head (Boat) Trailhead",
  "Lincoln Lake": "Lincoln Lake Trailhead",
  "Lee Ridge Trail": "Lee Ridge Trailhead",
  "Loop Trail": "Quartz Lake Loop Trailhead",
  "Red Eagle Trail": "Red Eagle Trailhead",
  "Siyeh Bend": "Siyeh Bend Trailhead",
  "Swiftcurrent Trail": "Swiftcurrent Trailhead",
  "Sperry Trail": "Sperry Trailhead",
  "Two Medicine North Shore Trail": "North Shore Trailhead",
  "Two Medicine South Shore Trail": "South Shore Trailhead",
};

interface RawDivision {
  id: string;
  name: string;
  code: string;
  district?: string;
  is_hidden?: boolean;
}
interface RawEntrance {
  id: string;
  name: string;
  type: string;
  town?: string;
}

async function main() {
  const raw = JSON.parse(await readFile(join(dataDir, "permits-raw.json"), "utf-8"));
  const payload = raw[0].payload;
  const divisions: RawDivision[] = Object.values(payload.divisions ?? {});
  const entrances: RawEntrance[] = payload.entrances ?? [];

  console.log("Fetching OSM backcountry campsite nodes...");
  const campNodes = await fetchOverpass(
    `[out:json][timeout:60];(node["tourism"="camp_site"](${BBOX});node["tourism"="camp_pitch"](${BBOX}););out body;`,
  );
  console.log("Fetching OSM trailhead nodes...");
  const trailheadNodes = await fetchOverpass(
    `[out:json][timeout:60];(node["highway"="trailhead"](${BBOX});node["tourism"="trailhead"](${BBOX}););out body;`,
  );

  const campByToken = new Map<string, OverpassNode>();
  const campByName = new Map<string, OverpassNode>();
  for (const n of campNodes) {
    const name = n.tags?.name;
    if (!name) continue;
    campByToken.set(normTokens(name), n);
    campByName.set(name, n);
  }
  const trailheadByToken = new Map<string, OverpassNode>();
  const trailheadByName = new Map<string, OverpassNode>();
  for (const n of trailheadNodes) {
    const name = n.tags?.name;
    if (!name) continue;
    // A few nodes carry more than one trail's name on the same physical trailhead,
    // semicolon-joined (e.g. "Swiftcurrent Trailhead;Iceberg Ptarmigan Trailhead") —
    // index by each part separately so alias/token lookups match either half.
    for (const part of name.split(";")) {
      trailheadByToken.set(normTokens(part), n);
      trailheadByName.set(part, n);
    }
  }

  const records: DerivedRecord[] = [];
  // Recreation.gov's own numeric division id (e.g. "4675321044") for each matched campsite — not
  // part of campsites.json itself (that's app-facing data, this is Recreation.gov-API-facing), but
  // needed by the chat agent's live permit-availability tool, which calls
  // `/api/permititinerary/<permitId>/division/<divisionId>/availability/month` per site. Keyed by
  // our own slug id so the tool can go straight from a campsite the model already knows about to
  // the numeric id Recreation.gov expects, without re-deriving it at request time.
  const divisionIdBySlug: Record<string, string> = {};
  let campMatched = 0;
  const campUnmatched: string[] = [];
  for (const d of divisions) {
    if (d.is_hidden) continue; // ranger stations / cabins / lookouts / auto CGs / zones / CDT hitch-rails / admin sites
    const base = stripCode(d.name);
    const aliasTarget = CAMPSITE_ALIASES[base];
    const node = aliasTarget ? campByName.get(aliasTarget) : campByToken.get(normTokens(base));
    if (!node) {
      campUnmatched.push(d.name);
      continue;
    }
    campMatched++;
    const id = slugify(d.name);
    divisionIdBySlug[id] = d.id;
    records.push({
      id,
      name: d.name,
      lat: node.lat,
      lon: node.lon,
      type: "designated_campsite",
      context: d.district || undefined,
      startingAreas: d.district ? [d.district] : undefined,
    });
  }

  let entranceMatched = 0;
  const entranceUnmatched: string[] = [];
  for (const e of entrances) {
    if (e.type === "Issue Station") continue; // ranger station / permit office, not a starting point
    const base = stripCode(e.name);
    const aliasTarget = ENTRANCE_ALIASES[base];
    const node = aliasTarget ? trailheadByName.get(aliasTarget) : trailheadByToken.get(normTokens(base));
    if (!node) {
      entranceUnmatched.push(e.name);
      continue;
    }
    entranceMatched++;
    records.push({
      id: slugify(e.name),
      name: e.name,
      lat: node.lat,
      lon: node.lon,
      type: "trailhead",
      context: e.town || undefined,
    });
  }

  await writeFile(join(dataDir, "campsites.json"), JSON.stringify(records, null, 2) + "\n");
  await writeFile(join(dataDir, "permit-divisions.json"), JSON.stringify({ permitId: "4675321", divisionIdBySlug }, null, 2) + "\n");

  console.log(`Backcountry campsites: ${campMatched} matched, ${campUnmatched.length} dropped (no OSM coordinate found):`);
  console.log(" ", campUnmatched.join(", "));
  console.log(`Trailheads: ${entranceMatched} matched, ${entranceUnmatched.length} dropped (no OSM coordinate found):`);
  console.log(" ", entranceUnmatched.join(", "));
  console.log(`Wrote ${records.length} records to data/glacier/campsites.json`);
}

main();
