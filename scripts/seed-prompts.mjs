// One-time (re-runnable) seed: upload the fallback prompts into Langfuse
// Prompt Management with the "production" label, so non-devs can edit them in
// the Langfuse UI. Skips prompts that already exist (won't bump versions).
// Run: npm run seed-prompts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "./_load-env.mjs";

loadEnv();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FALLBACK_DIR = join(ROOT, "prompts", "fallback");
const NAMES = ["router", "hr", "product", "general"];

const pk = process.env.LANGFUSE_PUBLIC_KEY;
const sk = process.env.LANGFUSE_SECRET_KEY;
const host = process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com";
if (!pk || !sk) {
  console.error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set");
  process.exit(1);
}
const auth = Buffer.from(`${pk}:${sk}`).toString("base64");

async function exists(name) {
  const res = await fetch(`${host}/api/public/v2/prompts/${name}?label=production`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return res.ok;
}

async function create(name, text) {
  const res = await fetch(`${host}/api/public/v2/prompts`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      type: "text",
      prompt: text,
      labels: ["production"],
      commitMessage: "Seed from prompts/fallback (initial migration)",
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

for (const name of NAMES) {
  if (await exists(name)) {
    console.log(`⏭️  "${name}" already exists in Langfuse (production) — skip`);
    continue;
  }
  const text = readFileSync(join(FALLBACK_DIR, `${name}.txt`), "utf8");
  const r = await create(name, text);
  if (r.ok) {
    let v = "?";
    try { v = JSON.parse(r.body).version; } catch {}
    console.log(`✅ "${name}" created → version ${v} (label=production, ${text.length} chars)`);
  } else {
    console.log(`❌ "${name}" failed HTTP ${r.status}: ${r.body.slice(0, 300)}`);
  }
}
