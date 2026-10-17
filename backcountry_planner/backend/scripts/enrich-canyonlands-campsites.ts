// Fills Canyonlands' Recreation.gov records (whose coordinates are zero) from
// OSM's named backcountry camp nodes and the official NPS zone polygons.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slugify, type DerivedRecord } from "./lib/deriveRecords.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data", "canyonlands-national-park-overnight-backcountry-permits");
const bbox = "37.75,-110.55,39.5,-109.0";
const CAMP_ALIASES: Record<string, string> = {
  "Murphy A": "Murphy Hogback A", "Murphy B": "Murphy Hogback B", "Murphy C": "Murphy Hogback C",
  "Potato Bottom A": "Potato Bottom A", "Potato Bottom B": "Potato Bottom B", "Potato Bottom C": "Potato Bottom C",
};

type Node = { lat: number; lon: number; tags?: Record<string, string> };
type Division = { id: string; name: string; is_hidden?: boolean };
type Entrance = { id: string; name: string; type: string; town?: string };

async function overpass(query: string): Promise<Node[]> {
  try {
    const cached = JSON.parse(await readFile("/tmp/canyon-camps-osm.json", "utf8")) as { elements: Node[] };
    if (cached.elements.length) return cached.elements;
  } catch { /* fetch below */ }
  const { stdout } = await execFileAsync("curl", ["-s", "--fail", "--max-time", "120", "https://overpass-api.de/api/interpreter", "--data-urlencode", `data=${query}`], { maxBuffer: 50 * 1024 * 1024 });
  return (JSON.parse(stdout) as { elements: Node[] }).elements;
}

function key(value: string): string {
  return value.toLowerCase().replace(/campsite|campground|backcountry|zone|the|\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, "");
}

function distance(a: Node, b: Node): number {
  const dLat = (a.lat - b.lat) * 111_000;
  const dLon = (a.lon - b.lon) * 88_000;
  return Math.hypot(dLat, dLon);
}

function center(geometry: unknown): { lat: number; lon: number } | null {
  const points: number[][] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") points.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit((geometry as { coordinates?: unknown })?.coordinates);
  if (!points.length) return null;
  return { lon: points.reduce((sum, p) => sum + p[0], 0) / points.length, lat: points.reduce((sum, p) => sum + p[1], 0) / points.length };
}

async function main() {
  const raw = JSON.parse(await readFile(join(dataDir, "permits-raw.json"), "utf8"))[0].payload;
  const divisions = Object.values(raw.divisions ?? {}) as Division[];
  const entrances = raw.entrances as Entrance[];
  const osm = await overpass(`[out:json][timeout:120];(node["tourism"="camp_site"](${bbox});node["tourism"="camp_pitch"](${bbox});node["highway"="trailhead"](${bbox});node["tourism"="trailhead"](${bbox}););out body;`);
  let trailheadSource = osm;
  try {
    trailheadSource = (JSON.parse(await readFile("/tmp/canyon-trailheads.json", "utf8")) as { elements: Node[] }).elements;
  } catch { /* the combined Overpass response above is sufficient */ }
  const camps = osm.filter((n) => ["camp_site", "camp_pitch"].includes(n.tags?.tourism ?? ""));
  const trailheads = trailheadSource.filter((n) => n.tags?.highway === "trailhead" || n.tags?.tourism === "trailhead");
  const campByKey = new Map(camps.filter((n) => n.tags?.name).map((n) => [key(n.tags!.name), n]));
  const trailheadByKey = new Map(trailheads.filter((n) => n.tags?.name).map((n) => [key(n.tags!.name), n]));
  const zones = JSON.parse(await readFile(join(dataDir, "zones.geojson"), "utf8")) as { features: { properties?: { name?: string }; geometry?: unknown }[] };
  const records: DerivedRecord[] = [];
  const divisionIdBySlug: Record<string, string> = {};
  let matched = 0;
  for (const division of divisions) {
    if (division.is_hidden) continue;
    const name = division.name.replace(/\s*\([^)]*\)/g, "").trim();
    const code = division.name.match(/\(([A-Z]{2,3}\d+)\)/)?.[1];
    let node = (code && campByKey.get(key(code))) || campByKey.get(key(CAMP_ALIASES[name] ?? name));
    if (!node && !/zone$/i.test(name)) {
      const targetKey = key(name);
      const candidates = camps.filter((n) => {
        const campKey = key(n.tags?.name ?? "");
        return Boolean(targetKey && campKey && (campKey.includes(targetKey) || targetKey.includes(campKey)));
      });
      node = candidates.sort((a, b) => distance(a, { lat: 38.3, lon: -109.8 }) - distance(b, { lat: 38.3, lon: -109.8 }))[0];
    }
    let coords = node ? { lat: node.lat, lon: node.lon } : null;
    let type: DerivedRecord["type"] = "designated_campsite";
    if (!coords && /zone$/i.test(name)) {
      const zone = zones.features.find((f) => key(f.properties?.name ?? "") === key(name) || key(f.properties?.name ?? "").includes(key(name)) || key(name).includes(key(f.properties?.name ?? "")));
      coords = zone?.geometry ? center(zone.geometry) : null;
      type = "at_large";
    }
    if (!coords) continue;
    const id = slugify(division.name);
    records.push({ id, name: division.name, ...coords, type });
    divisionIdBySlug[id] = division.id;
    matched++;
  }
  const entranceAliases: Record<string, string> = { "Elephant Hill Trailhead (The Needles)": "Elephant Hill Trailhead", "Needles Campground Trailhead (The Needles)": "Needles Campground Trailhead", "Gooseberry Trailhead (Island in the Sky)": "Gooseberry Trailhead", "Murphy Trailhead (Island in the Sky)": "Murphy Trailhead", "Hans Flat Ranger Station (The Maze)": "Hans Flat Ranger Station" };
  for (const entrance of entrances) {
    if (entrance.type === "Issuing Station") continue;
    const n = trailheadByKey.get(key(entranceAliases[entrance.name] ?? entrance.name));
    if (!n) continue;
    records.push({ id: slugify(entrance.name), name: entrance.name, lat: n.lat, lon: n.lon, type: "trailhead", context: entrance.town || undefined });
  }
  await writeFile(join(dataDir, "campsites.json"), JSON.stringify(records, null, 2) + "\n");
  await writeFile(join(dataDir, "permit-divisions.json"), JSON.stringify({ permitId: "4675315", divisionIdBySlug }, null, 2) + "\n");
  console.log(`Matched ${matched}/${divisions.filter((d) => !d.is_hidden).length} divisions and wrote ${records.length} records.`);
}

main();
