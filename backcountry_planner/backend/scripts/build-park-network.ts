// Pulls hiking-trail and drivable-road line data from OpenStreetMap (via the
// public Overpass API) for the bounding box around a park's scraped
// campsites, and writes trails.geojson / roads.geojson in the same schema as
// the hand-built grand-canyon/rocky-mountain data.
//
// Usage: npx tsx scripts/build-park-network.ts <parkSlug> [padDegrees]
//
// NOTE: unlike grand-canyon/rocky-mountain, this network is NOT manually
// checked for gaps (see MANUAL_CONNECTORS in src/graph.ts) — campsite
// snapping has no distance cutoff, so sparse OSM coverage near a campsite
// will silently snap it to the nearest available (possibly wrong) trail.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

const TRAIL_HIGHWAYS = new Set(["path", "footway", "bridleway", "steps", "cycleway"]);
// Excludes only trunk/motorway (real interstates/highways — essentially never actual trailhead
// access). residential/service are INCLUDED despite adding noise for geographically dispersed
// parks (Joshua Tree, Grand Canyon full system, North Cascades all sweep in real towns) — a
// single named road is frequently tagged with different highway values along its own length
// (Rocky Mountain's own "North Inlet Road" is part tertiary, part residential, right through
// Grand Lake), so excluding residential silently truncated a real access road and forced routes
// onto a multi-mile detour instead of the short way through town. Visual clutter in dispersed
// parks is the accepted tradeoff for not breaking connectivity in compact ones.
const ROAD_HIGHWAYS = new Set(["track", "unclassified", "tertiary", "secondary", "primary", "residential", "service"]);
const ALL_HIGHWAYS = [...TRAIL_HIGHWAYS, ...ROAD_HIGHWAYS];

interface OverpassWay {
  type: "way";
  id: number;
  tags?: { name?: string; highway?: string };
  geometry?: { lat: number; lon: number }[];
}

interface Feature {
  type: "Feature";
  properties: { name: string; osm_way_id: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

// Node's fetch (undici) trips a 406 on overpass-api.de's Apache front end that plain curl
// doesn't — rather than chase undici's header quirks, just shell out to curl.
async function fetchOverpass(query: string): Promise<OverpassWay[]> {
  const marker = "\nHTTP_STATUS:%{http_code}";
  const { stdout } = await execFileAsync(
    "curl",
    ["-s", "-m", "340", "https://lz4.overpass-api.de/api/interpreter", "--data-urlencode", `data=${query}`, "-w", marker],
    { maxBuffer: 1024 * 1024 * 200 },
  );
  const splitAt = stdout.lastIndexOf("\nHTTP_STATUS:");
  const body = stdout.slice(0, splitAt);
  const status = stdout.slice(splitAt + "\nHTTP_STATUS:".length).trim();
  if (status !== "200") {
    throw new Error(`Overpass request failed: HTTP ${status}\n${body.slice(0, 2000)}`);
  }
  return JSON.parse(body).elements;
}

async function main() {
  const [parkSlug, padArg] = process.argv.slice(2);
  if (!parkSlug) {
    console.error("Usage: npx tsx scripts/build-park-network.ts <parkSlug> [padDegrees]");
    process.exit(1);
  }
  const pad = padArg ? Number(padArg) : 0.05;

  const dataDir = join(__dirname, "..", "data", parkSlug);
  const allCampsites: { lat: number | null; lon: number | null }[] = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(join(dataDir, "campsites.json"), "utf-8")),
  );
  // Some parks (e.g. zone-based permit systems like Shenandoah/Grand Teton) have
  // records with no lat/lon yet — Math.min/max coerce null to 0, which silently
  // drags the bbox toward null island if these aren't filtered out first.
  const campsites = allCampsites.filter(
    (c): c is { lat: number; lon: number } => c.lat != null && c.lon != null,
  );
  if (campsites.length === 0) {
    console.error(`No campsites with coordinates in ${dataDir}/campsites.json — nothing to bound a query around.`);
    process.exit(1);
  }

  const lats = campsites.map((c) => c.lat);
  const lons = campsites.map((c) => c.lon);
  const south = Math.min(...lats) - pad;
  const north = Math.max(...lats) + pad;
  const west = Math.min(...lons) - pad;
  const east = Math.max(...lons) + pad;
  console.log(`Bounding box (padded ${pad}°): south=${south} west=${west} north=${north} east=${east}`);
  console.log(`Suggested center: [${((south + north) / 2).toFixed(4)}, ${((west + east) / 2).toFixed(4)}]`);

  const query = `[out:json][timeout:300];\nway["highway"~"^(${ALL_HIGHWAYS.join("|")})$"](${south},${west},${north},${east});\nout geom;`;

  console.log("Querying Overpass (this can take a while for large parks)...");
  const elements = await fetchOverpass(query);
  console.log(`Got ${elements.length} ways from OSM.`);

  const trailFeatures: Feature[] = [];
  const roadFeatures: Feature[] = [];

  for (const way of elements) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const highway = way.tags?.highway ?? "";
    const feature: Feature = {
      type: "Feature",
      properties: { name: way.tags?.name ?? "", osm_way_id: way.id },
      geometry: {
        type: "LineString",
        coordinates: way.geometry.map((p) => [p.lon, p.lat] as [number, number]),
      },
    };
    if (TRAIL_HIGHWAYS.has(highway)) trailFeatures.push(feature);
    else if (ROAD_HIGHWAYS.has(highway)) roadFeatures.push(feature);
  }

  await writeFile(
    join(dataDir, "trails.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: trailFeatures }) + "\n",
  );
  await writeFile(
    join(dataDir, "roads.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: roadFeatures }) + "\n",
  );

  console.log(`Wrote ${trailFeatures.length} trail features, ${roadFeatures.length} road features to ${dataDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
