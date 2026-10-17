// One-off: merges the NPS ArcGIS backcountry permit-area polygons (fetched
// separately into scripts/rec-gov-debug/shen-zones.geojson) into the
// Shenandoah data:
//   - writes data/shenandoah/zones.geojson (polygon boundaries, for map shading)
//   - fills lat/lon on matching at_large campsites.json records with a
//     guaranteed-inside-polygon point (pointOnFeature), replacing the
//     null placeholders left by scrape-permit-campsites.ts
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pointOnFeature from "@turf/point-on-feature";
import type { Feature, FeatureCollection, Polygon } from "@turf/helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const zonesPath = join(__dirname, "rec-gov-debug", "shen-zones.geojson");
const campsitesPath = join(__dirname, "..", "data", "shenandoah", "campsites.json");
const outZonesPath = join(__dirname, "..", "data", "shenandoah", "zones.geojson");

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Recreation.gov and the NPS ArcGIS layer disagree on this zone's spelling
// ("Weakly" vs "Weakley Hollow") — confirmed same place, aliased by hand.
const NAME_ALIASES: Record<string, string> = {
  "Old Rag - Weakly Hollow": "Old Rag - Weakley Hollow",
};

async function main() {
  const zones: FeatureCollection<Polygon, { NAME: string }> = JSON.parse(
    await readFile(zonesPath, "utf-8")
  );
  const campsites: Array<{
    id: string;
    name: string;
    lat: number | null;
    lon: number | null;
    type: string;
    context?: string;
  }> = JSON.parse(await readFile(campsitesPath, "utf-8"));

  const zoneByNormName = new Map<string, Feature<Polygon, { NAME: string }>>();
  for (const f of zones.features) {
    zoneByNormName.set(normalize(f.properties.NAME), f);
  }

  let matched = 0;
  const unmatched: string[] = [];
  for (const c of campsites) {
    if (c.type !== "at_large") continue;
    const zone = zoneByNormName.get(normalize(NAME_ALIASES[c.name] ?? c.name));
    if (!zone) {
      unmatched.push(c.name);
      continue;
    }
    const point = pointOnFeature(zone);
    const [lon, lat] = point.geometry.coordinates;
    c.lat = lat;
    c.lon = lon;
    matched++;
  }

  // Drop any record still missing coordinates (e.g. "AT Long Distance", a
  // virtual whole-trail option with no polygon of its own) — the app's
  // Campsite type requires a plottable point.
  const plottable = campsites.filter((c) => c.lat !== null && c.lon !== null);
  await writeFile(campsitesPath, JSON.stringify(plottable, null, 2) + "\n");

  const outZones: FeatureCollection = {
    type: "FeatureCollection",
    features: zones.features.map((f) => ({
      type: "Feature",
      properties: { name: f.properties.NAME },
      geometry: f.geometry,
    })),
  };
  await writeFile(outZonesPath, JSON.stringify(outZones) + "\n");

  console.log(`Matched ${matched} zones to polygons, filled representative points.`);
  console.log(`Unmatched (left as null):`, unmatched);
  console.log(`Wrote ${outZonesPath}`);
}

main();
