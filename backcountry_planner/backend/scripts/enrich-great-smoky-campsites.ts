// Replaces the zero-coordinate Recreation.gov records for Great Smoky Mountains
// with the park's authoritative public ArcGIS campsite, shelter, and trailhead
// layers. Run after scrape-permit-campsites.ts for permit 4675347.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slugify, type DerivedRecord } from "./lib/deriveRecords.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data", "great-smoky-mountains-national-park");
const service = "https://services.arcgis.com/yLA6mQfrA0yQr00r/ArcGIS/rest/services/GRSM_Natl_Park/FeatureServer";
const SHELTER_ALIASES: Record<string, string> = {
  "Tricorner Knob": "Tricorner",
  "Mount LeConte": "Mt LeConte",
};
const TRAILHEAD_ALIASES: Record<string, string> = {
  "Balsam Mountain Trailhead": "Balsam Mountain Trail",
  "Chestnut Branch Trailhead": "Chesnut Branch Trail",
  "Chestnut Top Trailhead": "Chesnut Top Trailhead",
  "Low Gap Trailhead": "Low Gap Trail",
  "Maddron Bald Trailhead": "Maddron Bald Trail",
  "Mount Sterling Trailhead": "Mt Sterling Trail",
  "Newton Bald Trailhead": "Newton Bald Trail",
  "Rich Mountain Loop Trailhead": "Rich Mountain Loop Trail",
  "Sugarland Mountains Trailhead": "Sugarland Mtn Trailhead",
  "Tunnel Bypass Trailhead": "Tunnel Bypass Trail",
};

type PointFeature = { geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> };
type RawDivision = { id: string; name: string; is_hidden?: boolean };
type RawEntrance = { id: string; name: string; type: string; town?: string };

async function query(layer: number): Promise<PointFeature[]> {
  const params = new URLSearchParams({ where: "1=1", outFields: "*", returnGeometry: "true", f: "geojson" });
  const response = await fetch(`${service}/${layer}/query?${params}`);
  if (!response.ok) throw new Error(`ArcGIS layer ${layer}: HTTP ${response.status}`);
  const json = await response.json() as { features?: PointFeature[] };
  return json.features ?? [];
}

function key(value: string): string {
  return value.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, "");
}

function point(feature: PointFeature): { lat: number; lon: number } | null {
  const [lon, lat] = feature.geometry?.coordinates ?? [];
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

async function main() {
  const raw = JSON.parse(await readFile(join(dataDir, "permits-raw.json"), "utf8"))[0].payload;
  const divisions = Object.values(raw.divisions ?? {}) as RawDivision[];
  const entrances = (raw.entrances ?? []) as RawEntrance[];
  const [trailheads, shelters, camps] = await Promise.all([query(0), query(1), query(2)]);

  const campByNumber = new Map<string, PointFeature>();
  for (const feature of camps) {
    const label = String(feature.properties?.LABEL ?? feature.properties?.NAME ?? "");
    const match = label.match(/#?\s*0*(\d+)/);
    if (match) campByNumber.set(match[1], feature);
  }
  const shelterByKey = new Map<string, PointFeature>();
  for (const feature of shelters) {
    const name = String(feature.properties?.NAME ?? "").replace(/ shelter$/i, "");
    shelterByKey.set(key(name), feature);
  }
  const trailheadByKey = new Map<string, PointFeature>();
  for (const feature of trailheads) {
    const name = String(feature.properties?.Name ?? feature.properties?.NAME ?? "");
    trailheadByKey.set(key(name), feature);
  }

  const records: DerivedRecord[] = [];
  const divisionIdBySlug: Record<string, string> = {};
  let campsiteMatched = 0;
  const campsiteUnmatched: string[] = [];
  for (const division of divisions) {
    if (division.is_hidden) continue;
    const campsiteNumber = division.name.match(/^Campsite\s+(\d+)/i)?.[1];
    const shelterBaseName = division.name.replace(/\s*\([^)]*\).*$/, "").trim();
    const shelterName = SHELTER_ALIASES[shelterBaseName] ?? shelterBaseName;
    const feature = campsiteNumber ? campByNumber.get(String(Number(campsiteNumber))) : shelterByKey.get(key(shelterName));
    const coords = feature && point(feature);
    if (!coords) { campsiteUnmatched.push(division.name); continue; }
    const id = slugify(division.name);
    divisionIdBySlug[id] = division.id;
    records.push({ id, name: division.name, ...coords, type: "designated_campsite" });
    campsiteMatched++;
  }

  let trailheadMatched = 0;
  const trailheadUnmatched: string[] = [];
  for (const entrance of entrances) {
    if (entrance.type === "Issue Station") continue;
    const trailheadName = TRAILHEAD_ALIASES[entrance.name] ?? entrance.name;
    const feature = trailheadByKey.get(key(trailheadName));
    const coords = feature && point(feature);
    if (!coords) { trailheadUnmatched.push(entrance.name); continue; }
    records.push({ id: slugify(entrance.name), name: entrance.name, ...coords, type: "trailhead", context: entrance.town || undefined });
    trailheadMatched++;
  }

  await writeFile(join(dataDir, "campsites.json"), JSON.stringify(records, null, 2) + "\n");
  await writeFile(join(dataDir, "permit-divisions.json"), JSON.stringify({ permitId: "4675347", divisionIdBySlug }, null, 2) + "\n");
  console.log(`Matched ${campsiteMatched}/${divisions.filter((d) => !d.is_hidden).length} backcountry divisions.`);
  console.log(`Matched ${trailheadMatched}/${entrances.length} trailheads.`);
  if (campsiteUnmatched.length) console.log("Unmatched divisions:", campsiteUnmatched.join(", "));
  if (trailheadUnmatched.length) console.log("Unmatched trailheads:", trailheadUnmatched.join(", "));
  console.log(`Wrote ${records.length} records.`);
}

main();
