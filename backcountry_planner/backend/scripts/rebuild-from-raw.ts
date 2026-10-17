// Regenerates campsites.json for every already-scraped park from its cached
// permits-raw.json — no network calls. Use this whenever deriveCampsiteRecords'
// logic changes (a new data-quality fix, a new field) so already-built parks
// pick it up without re-hitting Recreation.gov.
//
// Usage: npx tsx scripts/rebuild-from-raw.ts
//
// Shenandoah is deliberately excluded — its campsites.json depends on the
// null-coord zone placeholders plus a separate zone-polygon fill-in step
// (build-shenandoah-zones.ts). Regenerate it via:
//   npx tsx scripts/scrape-permit-campsites.ts 4675336 shenandoah
//   npx tsx scripts/build-shenandoah-zones.ts
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveCampsiteRecords, type DerivedRecord } from "./lib/deriveRecords.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const SKIP = new Set(["shenandoah"]);

async function main() {
  const entries = await readdir(DATA_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const parkDir = join(DATA_DIR, entry.name);
    const rawPath = join(parkDir, "permits-raw.json");
    if (!existsSync(rawPath)) continue;

    const rawEntries: { permitId: string; permitName: string; payload: any }[] = JSON.parse(
      await readFile(rawPath, "utf-8"),
    );

    const byId = new Map<string, DerivedRecord & { lat: number; lon: number }>();
    for (const r of rawEntries) {
      const records = deriveCampsiteRecords(r.payload).filter(
        (rec): rec is DerivedRecord & { lat: number; lon: number } => rec.lat !== null && rec.lon !== null,
      );
      for (const rec of records) byId.set(rec.id, rec);
    }

    const campsitesPath = join(parkDir, "campsites.json");
    const before = existsSync(campsitesPath) ? JSON.parse(await readFile(campsitesPath, "utf-8")).length : 0;
    const after = [...byId.values()];
    await writeFile(campsitesPath, JSON.stringify(after, null, 2) + "\n");

    const delta = after.length - before;
    console.log(`${entry.name}: ${before} -> ${after.length} records (${delta >= 0 ? "+" : ""}${delta})`);
  }

  console.log("\nDone. Remember to re-run scrape-permit-campsites.ts + build-shenandoah-zones.ts for shenandoah separately.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
