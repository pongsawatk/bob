// Continuous Improvement Analytics — Metric-Contract report (WP-10 CLI wiring).
// Numbers only (no raw traces printed → PII-safe). Reads Langfuse read-only.
//   npx tsx scripts/insight-report.mjs [7|14|30]
//
// This is the lib-backed successor to the trace/turn side of analyze-langfuse.mjs.
// All math lives in src/analytics/langfuse.ts (single source of truth, golden-tested).
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { fetchTraces, normalizeAll, aggregate, windowFor } = await import("../src/analytics/langfuse.ts");

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;
if (![7, 14, 30].includes(DAYS)) {
  console.error(`usage: insight-report.mjs [7|14|30]  (got ${DAYS})`);
  process.exit(1);
}

const creds = {
  host: (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, ""),
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
};
if (!creds.publicKey || !creds.secretKey) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}

const { current, previous } = windowFor(DAYS);
// Fetch once over the full 2× window, then aggregate each half — one round-trip.
const raw = await fetchTraces(creds, { fromMs: previous.fromMs, toMs: current.toMs });
const turns = normalizeAll(raw);
const cur = aggregate(turns, current);
const prev = aggregate(turns, previous);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const delta = (a, b) => {
  const d = a - b;
  const s = d > 0 ? "+" : "";
  return `${s}${d}`;
};

console.log(`\n=== BOB Insight — last ${DAYS}d (${cur.window.from.slice(0, 10)} → ${cur.window.to.slice(0, 10)}) ===`);
console.log(`data completeness: ${pct(cur.completeness)}${cur.completeness < 0.9 ? "  ⚠️ PARTIAL — treat conclusions with care" : ""}`);
console.log(`\n                        current    prev(${DAYS}d)   Δ`);
console.log(`turns                 ${String(cur.turns).padStart(8)} ${String(prev.turns).padStart(10)}   ${delta(cur.turns, prev.turns)}`);
console.log(`unique users          ${String(cur.uniqueUsers).padStart(8)} ${String(prev.uniqueUsers).padStart(10)}   ${delta(cur.uniqueUsers, prev.uniqueUsers)}`);
console.log(`sessions              ${String(cur.sessions).padStart(8)} ${String(prev.sessions).padStart(10)}   ${delta(cur.sessions, prev.sessions)}`);
console.log(`repeat users (≥2d)    ${String(cur.repeatUsers).padStart(8)} ${String(prev.repeatUsers).padStart(10)}   (${pct(cur.repeatUserRate)} vs ${pct(prev.repeatUserRate)}; target 25–30%)`);
console.log(`one-shot rate         ${pct(cur.oneShotRate).padStart(8)} ${pct(prev.oneShotRate).padStart(10)}`);
console.log(`\nintents:  ${Object.entries(cur.intents).map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`UNKNOWN turns: ${cur.unknownTurns}  |  truncated: ${cur.truncatedTurns}  |  from precache: ${cur.fromCacheTurns}`);
console.log(`latency  p50 ${(cur.latencyP50Ms / 1000).toFixed(1)}s  p95 ${(cur.latencyP95Ms / 1000).toFixed(1)}s`);
console.log(`cost     $${cur.costUsd.toFixed(4)} (prev $${prev.costUsd.toFixed(4)})`);
console.log(`\nnote: UNKNOWN is not yet split into "no-knowledge" vs "injection blocked" (Metric Contract §3, §6).`);
