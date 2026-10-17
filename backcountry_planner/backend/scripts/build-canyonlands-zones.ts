// Converts the four official NPS Canyonlands backcountry-zone KMZ files into
// the app's GeoJSON zone layer. The source files are linked from the park's
// maps page and contain surveyed zone polygons, including inner exclusion rings.
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = join(__dirname, "..", "data", "canyonlands-national-park-overnight-backcountry-permits");
const baseUrl = "https://www.nps.gov/cany/planyourvisit/upload/";
const sources = [
  ["CANY_ISKY_BC_Zones.kmz", "Island in the Sky"],
  ["CANY_NEED_BC_Zones.kmz", "The Needles"],
  ["CANY_MAZE_BC_Zones.kmz", "The Maze"],
  ["CANY_BackCountryZone.kmz", "Canyonlands / Orange Cliffs"],
] as const;

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseCoordinates(text: string): [number, number][] {
  return text.trim().split(/\s+/).map((tuple) => {
    const [lon, lat] = tuple.split(",").map(Number);
    return [lon, lat] as [number, number];
  }).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

async function main() {
  const features: unknown[] = [];
  for (const [file, district] of sources) {
    const kmzPath = `/tmp/canyonlands-zones-${process.pid}-${file}`;
    await execFileAsync("curl", ["-L", "--fail", "--silent", "--show-error", `${baseUrl}${file}`, "-o", kmzPath]);
    const { stdout: kml } = await execFileAsync("unzip", ["-p", kmzPath, "doc.kml"], { maxBuffer: 50 * 1024 * 1024 });
    const placemarks = kml.match(/<Placemark\b[\s\S]*?<\/Placemark>/g) ?? [];
    for (const placemark of placemarks) {
      const nameMatch = placemark.match(/<name>([\s\S]*?)<\/name>/);
      const name = decodeXml((nameMatch?.[1] ?? "Unnamed zone").trim());
      const polygons = [...placemark.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/g)].map((match) => {
        const polygon = match[0];
        const rings = [...polygon.matchAll(/<(?:outerBoundaryIs|innerBoundaryIs)[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)]
          .map((ring) => parseCoordinates(ring[1]));
        return rings.filter((ring) => ring.length >= 4);
      }).filter((rings) => rings.length > 0);
      if (!polygons.length) continue;
      const geometry = polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };
      features.push({ type: "Feature", properties: { name, district, source: `NPS ${file}` }, geometry });
    }
  }
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "zones.geojson"), JSON.stringify({ type: "FeatureCollection", features }, null, 2) + "\n");
  console.log(`Wrote ${features.length} Canyonlands zone features.`);
}

main();
