import { chromium } from "playwright";

async function main() {
  const parkId = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(`http://localhost:5173/park/${parkId}`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `scripts/rec-gov-debug/${parkId}-verify.png` });
  console.log("console errors:", errors);
  await browser.close();
}
main();
