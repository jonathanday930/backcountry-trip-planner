// Exports cookies/session from the logged-in persistent profile into a
// lightweight storageState.json, so later scripts can make authenticated
// API requests without launching a full browser.
// Run this once after rec-gov-login.ts, and again whenever the session expires.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const profileDir = join(__dirname, "rec-gov-profile");
const storageStatePath = join(__dirname, "rec-gov-storage-state.json");

async function main() {
  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  await context.storageState({ path: storageStatePath });
  await context.close();
  console.log(`Exported session to ${storageStatePath}`);
}

main();
