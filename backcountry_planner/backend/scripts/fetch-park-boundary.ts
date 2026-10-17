// Fetches a park/forest's own outer boundary polygon and writes boundary.geojson, used ONLY to
// decide how to render a road on the map (inside-park roads stay the brown "walkable road" style,
// outside-park roads get a muted style) — every road remains equally routable regardless of which
// side of this boundary it falls on. See PlannerPage.tsx's `isInsideBoundary` usage.
//
// Usage: npx tsx scripts/fetch-park-boundary.ts <parkDataDir> "<Nominatim search query>"
//
// Uses OSM's Nominatim search API (polygon_geojson=1) rather than Overpass: Nominatim returns an
// already-assembled Polygon/MultiPolygon straight from the OSM relation, sidestepping the ring
// -assembly work an Overpass relation query would otherwise require. Respect Nominatim's usage
// policy (https://operations.osmfoundation.org/policies/nominatim/) — max 1 request/sec, real
// User-Agent, no bulk geocoding — this script does one lookup per invocation, which is fine.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface NominatimResult {
  osm_type: string;
  osm_id: number;
  name: string;
  display_name: string;
  geojson?: {
    type: string;
    coordinates: unknown;
  };
}

async function main() {
  const [parkDataDir, query] = process.argv.slice(2);
  if (!parkDataDir || !query) {
    console.error('Usage: npx tsx scripts/fetch-park-boundary.ts <parkDataDir> "<Nominatim search query>"');
    process.exit(1);
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("limit", "1");

  console.log(`Querying Nominatim for "${query}"...`);
  const res = await fetch(url, {
    headers: { "User-Agent": "backcountry-trip-planner-dev (one-off park boundary fetch)" },
  });
  if (!res.ok) {
    console.error(`Nominatim request failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const results: NominatimResult[] = await res.json();
  const match = results[0];
  if (!match || !match.geojson) {
    console.error(`No polygon result for "${query}" — try a more specific query (the exact OSM name helps).`);
    process.exit(1);
  }
  if (match.geojson.type !== "Polygon" && match.geojson.type !== "MultiPolygon") {
    console.error(`Top result "${match.display_name}" is a ${match.geojson.type}, not a Polygon/MultiPolygon — pick a more specific query.`);
    process.exit(1);
  }
  console.log(`Matched "${match.display_name}" (osm_type=${match.osm_type}, osm_id=${match.osm_id}).`);

  const boundary = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { name: match.name },
        geometry: match.geojson,
      },
    ],
  };

  const dataDir = join(__dirname, "..", "data", parkDataDir);
  await writeFile(join(dataDir, "boundary.geojson"), JSON.stringify(boundary) + "\n");
  console.log(`Wrote ${dataDir}/boundary.geojson`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
