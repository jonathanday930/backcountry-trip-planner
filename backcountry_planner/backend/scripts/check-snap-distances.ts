import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph.js";

const parkSlug = process.argv[2];
const dataDir = join(process.cwd(), "data", parkSlug);
const allCampsites = JSON.parse(readFileSync(join(dataDir, "campsites.json"), "utf-8"));
// Zone-based parks (e.g. Grand Teton) can have records with no lat/lon yet, pending a
// zone-polygon/overlay fill-in step — not snappable until then.
const campsites = allCampsites.filter((c: any) => c.lat != null && c.lon != null);
const trails = JSON.parse(readFileSync(join(dataDir, "trails.geojson"), "utf-8"));
const roads = JSON.parse(readFileSync(join(dataDir, "roads.geojson"), "utf-8"));
const network = {
  type: "FeatureCollection",
  features: [...trails.features, ...roads.features],
};

const graph = buildGraph(network as any, campsites, parkSlug);

const spurDistances: { id: string; distanceMeters: number }[] = [];
for (const edge of graph.edges) {
  if (edge.from.startsWith("campsite:")) {
    spurDistances.push({ id: edge.from.replace("campsite:", ""), distanceMeters: edge.distanceMeters });
  }
}
spurDistances.sort((a, b) => b.distanceMeters - a.distanceMeters);
console.log(`${spurDistances.length} campsites needed a spur edge (not directly on network).`);
console.log("Worst 15 snap distances (meters):");
for (const s of spurDistances.slice(0, 15)) {
  const site = campsites.find((c: any) => c.id === s.id);
  console.log(`  ${s.distanceMeters.toFixed(0)}m  ${s.id}  (${site?.name})`);
}
