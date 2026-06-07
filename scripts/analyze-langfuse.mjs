// Pull GENERATION observations from Langfuse and summarize latency + cost.
// Usage: node scripts/analyze-langfuse.mjs [days=7] [--raw]
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;
const RAW = process.argv.includes("--raw");

const PUB = process.env.LANGFUSE_PUBLIC_KEY;
const SEC = process.env.LANGFUSE_SECRET_KEY;
const HOST = (process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
if (!PUB || !SEC) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${PUB}:${SEC}`).toString("base64");
const fromStartTime = new Date(Date.now() - DAYS * 864e5).toISOString();

async function fetchPage(page) {
  const url =
    `${HOST}/api/public/observations?type=GENERATION&limit=100&page=${page}` +
    `&fromStartTime=${encodeURIComponent(fromStartTime)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: AUTH } });
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
}

const all = [];
for (let page = 1; ; page++) {
  const body = await fetchPage(page);
  const data = body.data || [];
  all.push(...data);
  const totalPages = body.meta?.totalPages ?? 1;
  process.stderr.write(`\rfetched page ${page}/${totalPages} (${all.length} obs)`);
  if (page >= totalPages || data.length === 0) break;
}
process.stderr.write("\n");

if (RAW && all[0]) {
  console.log("SAMPLE OBSERVATION:\n", JSON.stringify(all[0], null, 2));
}

const num = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
const latencyOf = (o) =>
  o.latency != null ? o.latency * 1000 : new Date(o.endTime) - new Date(o.startTime); // Langfuse latency is in seconds
const costOf = (o) => num(o.calculatedTotalCost ?? o.totalCost ?? o.costDetails?.total);
const inTok = (o) => num(o.usage?.input ?? o.usage?.promptTokens ?? o.usageDetails?.input);
const outTok = (o) => num(o.usage?.output ?? o.usage?.completionTokens ?? o.usageDetails?.output);
const cacheTok = (o) => num(o.metadata?.cacheReadTokens);

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fmtUsd = (u) => `$${u.toFixed(5)}`;

// Group by generation name (router, domain:HR, ...)
const groups = new Map();
for (const o of all) {
  const key = o.name || "(unnamed)";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(o);
}

console.log(`\n=== Langfuse GENERATION summary — last ${DAYS}d (${all.length} generations) ===`);
console.log(`window from ${fromStartTime}\n`);

const rows = [];
for (const [name, obs] of groups) {
  const lats = obs.map(latencyOf);
  const costs = obs.map(costOf);
  const model = [...new Set(obs.map((o) => o.model))].join(",");
  const llm = obs.filter((o) => cacheTok(o) > 0 || inTok(o) > 0); // calls that actually hit LLM
  const cacheHits = obs.filter((o) => cacheTok(o) > 0).length;
  rows.push({
    name,
    model,
    n: obs.length,
    p50: pct(lats, 50),
    p95: pct(lats, 95),
    avgLat: lats.reduce((a, b) => a + b, 0) / obs.length,
    sumCost: costs.reduce((a, b) => a + b, 0),
    avgCost: costs.reduce((a, b) => a + b, 0) / obs.length,
    avgIn: inTok ? obs.reduce((a, o) => a + inTok(o), 0) / obs.length : 0,
    avgOut: obs.reduce((a, o) => a + outTok(o), 0) / obs.length,
    avgCache: obs.reduce((a, o) => a + cacheTok(o), 0) / obs.length,
    cacheHitRate: llm.length ? cacheHits / llm.length : 0,
  });
}
rows.sort((a, b) => b.sumCost - a.sumCost);

for (const r of rows) {
  console.log(`■ ${r.name}  [${r.model}]   n=${r.n}`);
  console.log(`    latency   p50 ${fmtMs(r.p50)}  p95 ${fmtMs(r.p95)}  avg ${fmtMs(r.avgLat)}`);
  console.log(
    `    cost      sum ${fmtUsd(r.sumCost)}  avg/call ${fmtUsd(r.avgCost)}`,
  );
  console.log(
    `    tokens    in ${Math.round(r.avgIn)}  out ${Math.round(r.avgOut)}  cacheRead ${Math.round(
      r.avgCache,
    )}  | cacheHitRate ${(r.cacheHitRate * 100).toFixed(0)}%`,
  );
  console.log("");
}

// Per-trace rollup (router + domain together = one user turn)
const byTrace = new Map();
for (const o of all) {
  const t = o.traceId;
  if (!byTrace.has(t)) byTrace.set(t, { cost: 0, lat: 0 });
  const e = byTrace.get(t);
  e.cost += costOf(o);
  e.lat += latencyOf(o); // router + domain are sequential
}
const traceCosts = [...byTrace.values()].map((e) => e.cost);
const traceLats = [...byTrace.values()].map((e) => e.lat);
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log(`=== Per user-turn (${byTrace.size} traces) ===`);
console.log(
  `    latency   p50 ${fmtMs(pct(traceLats, 50))}  p95 ${fmtMs(pct(traceLats, 95))}  avg ${fmtMs(
    sum(traceLats) / byTrace.size,
  )}`,
);
console.log(
  `    cost      total ${fmtUsd(sum(traceCosts))}  avg/turn ${fmtUsd(
    sum(traceCosts) / byTrace.size,
  )}`,
);
console.log(`    total spend (window) ${fmtUsd(sum(traceCosts))}`);
