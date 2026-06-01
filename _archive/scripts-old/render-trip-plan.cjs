const path = require("path");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  const bundledPlaywright = path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "node",
    "node_modules",
    ".pnpm",
    "playwright@1.60.0",
    "node_modules",
    "playwright",
  );
  ({ chromium } = require(bundledPlaywright));
}

async function main() {
  const root = process.cwd();
  const htmlPath = path.join(root, "docs", "trip-plan-bangkok-2026.html");
  const outPath = path.join(root, "docs", "trip-plan-bangkok-2026.png");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 2200 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();

  console.log(outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
