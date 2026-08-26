// Usage summary from Langfuse traces: volume, users, categories, daily trend.
// Usage: npx tsx scripts/analyze-usage.mjs [days=30] [--raw]
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 30;
const RAW = process.argv.includes("--raw");

const PUB = process.env.LANGFUSE_PUBLIC_KEY;
const SEC = process.env.LANGFUSE_SECRET_KEY;
const HOST = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
if (!PUB || !SEC) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}
const fromTimestamp = new Date(Date.now() - DAYS * 864e5).toISOString();
const { fetchTraces } = await import("../src/analytics/langfuse.ts");
const all = await fetchTraces(
  { host: HOST, publicKey: PUB, secretKey: SEC },
  { fromMs: Date.parse(fromTimestamp), toMs: Date.now() },
);

if (RAW && all[0]) console.log("SAMPLE TRACE:\n", JSON.stringify(all[0], null, 2));

const num = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
const tsOf = (t) => new Date(t.timestamp || t.createdAt);
// category lives in tags ([channel, category, precache|llm]) and/or metadata.category
const catOf = (t) => {
  const fromMeta = t.metadata?.category;
  if (fromMeta) return fromMeta;
  const known = ["HR", "PRODUCT", "GENERAL"];
  return (t.tags || []).find((x) => known.includes(x)) || "UNKNOWN";
};
const isPrecache = (t) => (t.tags || []).includes("precache");

const fmtDate = (d) => d.toISOString().slice(0, 10);
const bar = (n, max, width = 24) => "█".repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width)));

// ── Overall ───────────────────────────────────────────────────────
const users = new Map(); // userId -> count
const byCat = new Map();
const byDay = new Map();
const byHour = new Map(); // hour-of-day 0-23
const sessions = new Set();
let precacheHits = 0;
let totalCost = 0;

for (const t of all) {
  const u = t.userId || "(unknown)";
  users.set(u, (users.get(u) || 0) + 1);
  const c = catOf(t);
  byCat.set(c, (byCat.get(c) || 0) + 1);
  const d = fmtDate(tsOf(t));
  byDay.set(d, (byDay.get(d) || 0) + 1);
  const h = tsOf(t).getUTCHours();
  byHour.set(h, (byHour.get(h) || 0) + 1);
  if (t.sessionId) sessions.add(t.sessionId);
  if (isPrecache(t)) precacheHits++;
  totalCost += num(t.totalCost ?? t.calculatedTotalCost);
}

const firstDay = all.length ? fmtDate(new Date(Math.min(...all.map((t) => +tsOf(t))))) : "-";
const lastDay = all.length ? fmtDate(new Date(Math.max(...all.map((t) => +tsOf(t))))) : "-";
const activeDays = byDay.size;

console.log(`\n${"═".repeat(52)}`);
console.log(`  BOB Usage Summary — last ${DAYS}d`);
console.log(`  (${firstDay} → ${lastDay}, ${all.length} ข้อความ)`);
console.log(`${"═".repeat(52)}\n`);

console.log(`📊 ภาพรวม`);
console.log(`   ข้อความทั้งหมด     ${all.length}`);
console.log(`   ผู้ใช้ที่ไม่ซ้ำ       ${users.size} คน`);
console.log(`   บทสนทนา (sessions) ${sessions.size}`);
console.log(`   วันที่มีการใช้งาน    ${activeDays} วัน`);
console.log(`   เฉลี่ย/วันใช้งาน     ${(all.length / Math.max(1, activeDays)).toFixed(1)} ข้อความ`);
console.log(`   เฉลี่ย/คน          ${(all.length / Math.max(1, users.size)).toFixed(1)} ข้อความ`);
console.log(
  `   precache hit       ${precacheHits} (${((precacheHits / Math.max(1, all.length)) * 100).toFixed(0)}% ตอบจากแคชไม่เรียก LLM domain)`,
);
console.log("");

// ── By category ───────────────────────────────────────────────────
console.log(`🗂️  แยกตามหมวด`);
const maxCat = Math.max(...byCat.values());
for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((n / all.length) * 100).toFixed(0);
  console.log(`   ${c.padEnd(9)} ${String(n).padStart(4)} ${bar(n, maxCat)} ${pct}%`);
}
console.log("");

// ── Daily trend ───────────────────────────────────────────────────
console.log(`📅 รายวัน`);
const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const maxDay = Math.max(...byDay.values());
for (const [d, n] of days) {
  console.log(`   ${d}  ${String(n).padStart(3)} ${bar(n, maxDay)}`);
}
console.log("");

// ── Top users ─────────────────────────────────────────────────────
console.log(`👥 ผู้ใช้ที่ใช้บ่อยสุด (Top 10)`);
const top = [...users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
const maxU = top.length ? top[0][1] : 1;
for (const [u, n] of top) {
  console.log(`   ${String(n).padStart(3)} ${bar(n, maxU, 16)} ${u}`);
}
const singles = [...users.values()].filter((n) => n === 1).length;
console.log(
  `\n   (ใช้ครั้งเดียวแล้วหาย: ${singles}/${users.size} คน = ${((singles / Math.max(1, users.size)) * 100).toFixed(0)}%)`,
);
