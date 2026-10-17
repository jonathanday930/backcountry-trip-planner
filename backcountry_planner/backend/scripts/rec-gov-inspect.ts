// Debug helper: open a Recreation.gov URL with the saved login session,
// log every XHR/fetch response (URL + JSON body when available), and save
// a screenshot + full HTML so we can see how the page actually gets its
// campsite/itinerary-location data before writing a real scraper.
//
// Usage: npx tsx scripts/rec-gov-inspect.ts <url>
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const profileDir = join(__dirname, "rec-gov-profile");
const outDir = join(__dirname, "rec-gov-debug");

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npx tsx scripts/rec-gov-inspect.ts <url>");
    process.exit(1);
  }
  await import("node:fs/promises").then((fs) => fs.mkdir(outDir, { recursive: true }));

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());

  const apiHits: { url: string; status: number; body: unknown }[] = [];
  page.on("response", async (res) => {
    const reqUrl = res.url();
    const type = res.request().resourceType();
    if (type === "xhr" || type === "fetch") {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // not JSON, skip body
      }
      apiHits.push({ url: reqUrl, status: res.status(), body });
    }
  });

  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(5000); // let SPA finish client-side rendering/XHRs

  await page.screenshot({ path: join(outDir, "screenshot.png"), fullPage: true });
  await writeFile(join(outDir, "page.html"), await page.content());
  await writeFile(join(outDir, "api-hits.json"), JSON.stringify(apiHits, null, 2));

  console.log(`Wrote ${apiHits.length} API responses, screenshot, and HTML to ${outDir}`);
  await context.close();
}

main();
