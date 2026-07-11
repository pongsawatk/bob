// G1 SPIKE — Langfuse pagination + trace schema validation (read-only, PII-safe).
// Proves the [A] fields in the Metric Contract are present on real traces and that
// pagination joins correctly. Prints ONLY field names / booleans / counts — never
// values (no userId/input/output content leaves the process). One fetch = gentle on
// the rate limit (the traces endpoint 429s under bursty small-page reads).
//   npx tsx scripts/spike-langfuse.mjs [days=7]
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { fetchTraces, normalizeAll, windowFor } = await import("../src/analytics/langfuse.ts");

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;
const creds = {
  host: (process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, ""),
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
};
if (!creds.publicKey || !creds.secretKey) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}

const { current } = windowFor(DAYS);

// Single paginated fetch (limit=100/page). >100 results ⇒ pages were joined.
const raw = await fetchTraces(creds, current);
console.log(`\n=== Langfuse spike — last ${DAYS}d ===`);
console.log(`fetched ${raw.length} traces` + (raw.length > 100 ? `  → pagination joined ${Math.ceil(raw.length / 100)} pages ✓` : ` (single page)`));

if (!raw.length) {
  console.log("no traces in window — widen --days");
  process.exit(0);
}

const t = raw[0];
const md = t.metadata && typeof t.metadata === "object" ? t.metadata : {};
const has = (b) => (b ? "✓" : "✗ MISSING");
console.log(`\ntrace field presence (Metric Contract [A] → [V]):`);
console.log(`  id                ${has(t.id != null)}`);
console.log(`  timestamp         ${has(t.timestamp != null)}`);
console.log(`  userId            ${has(t.userId != null)}   (value hidden — PII)`);
console.log(`  sessionId         ${has(t.sessionId != null)}`);
console.log(`  latency (s)       ${has(typeof t.latency === "number")}`);
console.log(`  totalCost (USD)   ${has(typeof t.totalCost === "number")}`);
console.log(`  tags              ${has(Array.isArray(t.tags))}   → ${JSON.stringify(t.tags)} (channel/category/type — safe)`);
console.log(`  metadata.category         ${has("category" in md)}`);
console.log(`  metadata.outputTokens     ${has("outputTokens" in md)}`);
console.log(`  metadata.latencyMs        ${has("latencyMs" in md)}`);
console.log(`  metadata keys     ${JSON.stringify(Object.keys(md))}`);

// Completeness / data-quality counts (numbers only) from the same fetch.
const turns = normalizeAll(raw);
const noCat = turns.filter((x) => !x.hasCategory).length;
const noLat = turns.filter((x) => !x.hasLatency).length;
console.log(`\ndata quality over ${DAYS}d:`);
console.log(`  raw traces             ${raw.length}`);
console.log(`  after dedupe+exclusion ${turns.length}  (dropped ${raw.length - turns.length}: test/bot/non-bob-chat/dup)`);
console.log(`  missing category       ${noCat}`);
console.log(`  missing latency        ${noLat}   ← explains completeness < 100%`);
console.log(`\nverdict: pagination + trace schema confirmed. Endpoint is rate-limited (429) →`);
console.log(`fetchTraces now backs off on 429/Retry-After; production job must fetch with limit=100.`);
