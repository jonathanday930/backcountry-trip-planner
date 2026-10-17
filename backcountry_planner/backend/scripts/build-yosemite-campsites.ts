// Yosemite uses the NPS wilderness-permit system rather than a Recreation.gov
// permit-content endpoint. Build the app's map stops from named OSM wilderness
// camp and trailhead nodes; route definitions remain curated separately from
// this discovery feed.
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { slugify, type DerivedRecord } from "./lib/deriveRecords.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data", "yosemite-national-park");
const bbox = "37.35,-120.15,38.15,-118.85";

type Node = { lat: number; lon: number; tags?: Record<string, string> };

async function main() {
  const query = `[out:json][timeout:120];(node["tourism"="camp_site"](${bbox});node["tourism"="camp_pitch"](${bbox});node["highway"="trailhead"](${bbox});node["tourism"="trailhead"](${bbox}););out body;`;
  const { stdout } = await execFileAsync("curl", ["-s", "--fail", "--max-time", "180", "https://overpass-api.de/api/interpreter", "--data-urlencode", `data=${query}`], { maxBuffer: 50 * 1024 * 1024 });
  const nodes = (JSON.parse(stdout) as { elements: Node[] }).elements;
  const records: DerivedRecord[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const name = node.tags?.name?.trim();
    if (!name) continue;
    const isTrailhead = node.tags?.highway === "trailhead" || node.tags?.tourism === "trailhead";
    const id = slugify(name);
    if (seen.has(`${id}:${isTrailhead}`)) continue;
    seen.add(`${id}:${isTrailhead}`);
    records.push({ id, name, lat: node.lat, lon: node.lon, type: isTrailhead ? "trailhead" : "designated_campsite" });
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "campsites.json"), JSON.stringify(records, null, 2) + "\n");
  console.log(`Wrote ${records.length} named Yosemite OSM camp/trailhead records.`);
}

main();
