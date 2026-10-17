// Fetches a Recreation.gov wilderness/backcountry permit's reference data
// (trailheads/entrances + camp divisions/zones) and writes it out in this
// project's campsites.json schema.
//
// Usage: npx tsx scripts/scrape-permit-campsites.ts <permitId> <parkSlug>
// e.g.   npx tsx scripts/scrape-permit-campsites.ts 4675336 shenandoah
//
// Requires rec-gov-login.ts + rec-gov-export-storage.ts to have been run
// first so scripts/rec-gov-storage-state.json holds a valid session.
import { request } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deriveCampsiteRecords } from "./lib/deriveRecords.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storageStatePath = join(__dirname, "rec-gov-storage-state.json");

async function main() {
  const [permitId, parkSlug] = process.argv.slice(2);
  if (!permitId || !parkSlug) {
    console.error("Usage: npx tsx scripts/scrape-permit-campsites.ts <permitId> <parkSlug>");
    process.exit(1);
  }

  const ctx = await request.newContext({ storageState: storageStatePath });
  const res = await ctx.get(`https://www.recreation.gov/api/permitcontent/${permitId}`);
  if (!res.ok()) {
    console.error(`Request failed: ${res.status()} ${res.statusText()}`);
    process.exit(1);
  }
  const { payload } = await res.json();
  await ctx.dispose();

  const records = deriveCampsiteRecords(payload);

  const outDir = join(__dirname, "..", "data", parkSlug);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "campsites.json");
  await writeFile(outPath, JSON.stringify(records, null, 2) + "\n");

  // Full raw payload, unfiltered — preserves entrance.division_ids /
  // division.entry_ids/exit_ids (which starting points reach which
  // campsites/zones) that campsites.json intentionally drops for now.
  const rawPath = join(outDir, "permits-raw.json");
  type RawEntry = { permitId: string; permitName: string; payload: unknown };
  let rawEntries: RawEntry[] = [];
  try {
    rawEntries = JSON.parse(await readFile(rawPath, "utf-8"));
  } catch {
    // no existing file yet
  }
  rawEntries = rawEntries.filter((r) => r.permitId !== permitId);
  rawEntries.push({ permitId, permitName: payload.name ?? parkSlug, payload });
  await writeFile(rawPath, JSON.stringify(rawEntries, null, 2) + "\n");

  const missingCoords = records.filter((r) => r.lat === null).length;
  const trailheads = records.filter((r) => r.type === "trailhead").length;
  console.log(`Wrote ${records.length} records to ${outPath}`);
  console.log(`${trailheads} trailheads, ${records.length - trailheads} camp divisions`);
  console.log(`${missingCoords} records still need coordinates (lat/lon null)`);
}

main();
