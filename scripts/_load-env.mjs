// Minimal .env loader (no dependency) — reads <repo-root>/.env into process.env.
// Real environment variables take precedence over .env values.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function loadEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let raw;
  try {
    raw = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return; // no .env — rely on the real environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
