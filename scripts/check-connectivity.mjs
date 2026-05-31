// Phase 0 connectivity check — verifies every external service BOB depends on
// is reachable and the credentials in .env work. Pure fetch, no npm install needed.
//
//   node scripts/check-connectivity.mjs
//
// Exit code 0 = all configured services OK. Non-zero = at least one FAILED.
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const TIMEOUT_MS = 15000;
const results = [];

async function fetchT(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function record(name, status, detail) {
  results.push({ name, status, detail });
}

async function run(name, requiredEnv, fn) {
  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length) {
    record(name, "SKIP", `ยังไม่ได้ตั้ง: ${missing.join(", ")}`);
    return;
  }
  try {
    const detail = await fn();
    record(name, "OK", detail);
  } catch (err) {
    record(name, "FAIL", err?.message ?? String(err));
  }
}

// ── OpenRouter ──────────────────────────────────────────────
await run("OpenRouter", ["OPENROUTER_API_KEY"], async () => {
  const res = await fetchT("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  const usage = j?.data?.usage ?? 0;
  const limit = j?.data?.limit ?? "unlimited";
  return `key ok · usage=$${usage} · limit=${limit}`;
});

// ── Langfuse ────────────────────────────────────────────────
await run("Langfuse", ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"], async () => {
  const host = process.env.LANGFUSE_HOST || "https://cloud.langfuse.com";
  const auth = Buffer.from(
    `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`
  ).toString("base64");
  const res = await fetchT(`${host}/api/public/projects`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  const names = (j?.data ?? []).map((p) => p.name).join(", ") || "(no projects)";
  return `auth ok · projects: ${names}`;
});

// ── Upstash Redis (REST) ────────────────────────────────────
await run("Upstash Redis", ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], async () => {
  const base = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const headers = { Authorization: `Bearer ${token}` };
  const val = `phase0-${Date.now()}`;
  const setRes = await fetchT(`${base}/set/bob:healthcheck/${val}`, { headers });
  if (!setRes.ok) throw new Error(`SET HTTP ${setRes.status} ${await setRes.text()}`);
  const getRes = await fetchT(`${base}/get/bob:healthcheck`, { headers });
  if (!getRes.ok) throw new Error(`GET HTTP ${getRes.status} ${await getRes.text()}`);
  const j = await getRes.json();
  if (j?.result !== val) throw new Error(`round-trip mismatch: got ${JSON.stringify(j?.result)}`);
  return "set/get round-trip ok";
});

// ── Outline ─────────────────────────────────────────────────
await run("Outline", ["OUTLINE_BASE_URL", "OUTLINE_API_TOKEN"], async () => {
  const base = process.env.OUTLINE_BASE_URL.replace(/\/$/, "");
  const res = await fetchT(`${base}/api/auth.info`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OUTLINE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  const user = j?.data?.user?.name ?? "?";
  const team = j?.data?.team?.name ?? "?";
  return `auth ok · user=${user} · team=${team}`;
});

// ── Report ──────────────────────────────────────────────────
const icon = { OK: "✅", FAIL: "❌", SKIP: "⏭️ " };
console.log("\nBOB Phase 0 — Connectivity Check\n" + "─".repeat(48));
for (const r of results) {
  console.log(`${icon[r.status]} ${r.name.padEnd(16)} ${r.detail}`);
}
console.log("─".repeat(48));

const failed = results.filter((r) => r.status === "FAIL");
const ok = results.filter((r) => r.status === "OK").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
console.log(`สรุป: ${ok} OK · ${failed.length} FAIL · ${skipped} SKIP\n`);

process.exit(failed.length > 0 ? 1 : 0);
