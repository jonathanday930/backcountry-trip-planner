// One-time (or refresh) interactive login for the Recreation.gov scraper.
// Opens a real, visible Chromium window using a dedicated automation profile
// (separate from your personal Chrome profile). Log in by hand, then press
// Enter in this terminal — the session is saved to disk for scrape scripts
// to reuse headlessly.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const profileDir = join(__dirname, "rec-gov-profile");

async function main() {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.recreation.gov/", { waitUntil: "domcontentloaded" });

  console.log("\nLog in to Recreation.gov in the opened window.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter here once you're logged in... ");
  rl.close();

  await context.close();
  console.log(`Session saved to ${profileDir}`);
}

main();
