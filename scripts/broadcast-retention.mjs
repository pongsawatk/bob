// Broadcast adoption + week-2 retention: join the launch roster (143 recipients)
// against Langfuse traces (userId == email) and measure who tried BOB after the
// broadcast and who came back in week 2.
//
// Usage: npx tsx scripts/broadcast-retention.mjs [--broadcast=2026-07-08]
//                                             [--roster=test-results/broadcast-roster-launch-2026-07.csv]
//                                             [--list]
// Windows use ICT (UTC+7) day boundaries. week1 = broadcast day .. +6, week2 = +7 .. +13.
import { readFileSync } from "node:fs";
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const BROADCAST = arg("broadcast", "2026-07-08"); // ICT calendar day of the send
const ROSTER = arg("roster", "test-results/broadcast-roster-launch-2026-07.csv");
const LIST = process.argv.includes("--list");
const ICT_MS = 7 * 3600e3;

const PUB = process.env.LANGFUSE_PUBLIC_KEY;
const SEC = process.env.LANGFUSE_SECRET_KEY;
const HOST = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
if (!PUB || !SEC) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}

// ── Roster ────────────────────────────────────────────────────────
// CSV columns: email,name,nickname,variant,risk
function parseRoster(text) {
  const rows = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    const c = cells.map((s) => s.replace(/^"|"$/g, "").replace(/""/g, '"').trim());
    if (!c[0] || !c[0].includes("@")) continue;
    rows.push({ email: c[0].toLowerCase(), name: c[1], nickname: c[2], variant: c[3] });
  }
  return rows;
}
const roster = parseRoster(readFileSync(ROSTER, "utf8"));
const byEmail = new Map(roster.map((r) => [r.email, r]));

// ── Windows (ICT day → index relative to broadcast day) ───────────
const ictDayIndex = (isoTs) => {
  const dayMs = 864e5;
  const bcastDay = Math.floor((Date.parse(BROADCAST + "T00:00:00Z") - ICT_MS + ICT_MS) / dayMs);
  const traceDay = Math.floor((Date.parse(isoTs) + ICT_MS) / dayMs);
  return traceDay - bcastDay;
};
const now = new Date();
const daysElapsed = ictDayIndex(now.toISOString());

// ── Fetch traces from broadcast day onward ────────────────────────
const fromTimestamp = new Date(Date.parse(BROADCAST + "T00:00:00Z") - ICT_MS).toISOString();
const { fetchTraces } = await import("../src/analytics/langfuse.ts");
const traces = await fetchTraces(
  { host: HOST, publicKey: PUB, secretKey: SEC },
  { fromMs: Date.parse(fromTimestamp), toMs: Date.now() },
);

// ── Per-recipient activity (roster join) ──────────────────────────
// email -> { firstInput, dayIdxSet:Set<number> }
const act = new Map();
for (const t of traces) {
  const email = (t.userId || "").toLowerCase();
  if (!byEmail.has(email)) continue; // only roster recipients; drops eval + non-recipients
  const idx = ictDayIndex(t.timestamp || t.createdAt);
  if (idx < 0) continue; // before broadcast day
  let a = act.get(email);
  if (!a) act.set(email, (a = { first: null, firstTs: Infinity, days: new Set() }));
  a.days.add(idx);
  const ts = Date.parse(t.timestamp || t.createdAt);
  if (ts < a.firstTs) {
    a.firstTs = ts;
    a.first = t.input || "";
  }
}

const inWin = (days, lo, hi) => [...days].some((d) => d >= lo && d <= hi);
const RE_KNOW = /รู้จัก|ชื่อเล่น|เรียกผม|เรียกฉัน|จำ(ผม|ฉัน|ชื่อ)|know me|my name/i;

// ── Aggregate ─────────────────────────────────────────────────────
function bucket(list) {
  const total = list.length;
  const tried = list.filter((r) => act.has(r.email));
  const w1 = tried.filter((r) => inWin(act.get(r.email).days, 0, 6));
  const w2 = tried.filter((r) => inWin(act.get(r.email).days, 7, 13));
  const w1retained = w1.filter((r) => inWin(act.get(r.email).days, 7, 13));
  return { total, tried, w1, w2, w1retained };
}
const all = bucket(roster);
const matched = bucket(roster.filter((r) => r.variant === "matched"));
const fallback = bucket(roster.filter((r) => r.variant !== "matched"));

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) + "%" : "—");
const line = (label, b) =>
  `   ${label.padEnd(22)} ${String(b.tried.length).padStart(3)}/${String(b.total).padEnd(3)} ` +
  `(${pct(b.tried.length, b.total)})`;

console.log(`\n${"═".repeat(56)}`);
console.log(`  Broadcast Retention — launch-2026-07`);
console.log(`  broadcast day = ${BROADCAST} (ICT) · today = day ${daysElapsed}`);
console.log(`  recipients = ${roster.length} · traces since = ${traces.length}`);
console.log(`${"═".repeat(56)}\n`);

const w2Ready = daysElapsed >= 13;
const w1Ready = daysElapsed >= 6;

console.log(`📣 Adoption — tried BOB at least once since broadcast`);
console.log(line("ทั้งหมด", all));
console.log(line("matched (ทักชื่อเล่น)", matched));
console.log(line("fallback (ไม่เคลม)", fallback));
console.log("");

console.log(`📅 Week-1 (day 0–6, ${BROADCAST} → +6)${w1Ready ? "" : "  ⚠️ partial — window still open"}`);
console.log(`   ลองใน week-1        ${all.w1.length}/${all.total} (${pct(all.w1.length, all.total)})`);
console.log(`     ↳ matched         ${matched.w1.length}/${matched.total} (${pct(matched.w1.length, matched.total)})`);
console.log(`     ↳ fallback        ${fallback.w1.length}/${fallback.total} (${pct(fallback.w1.length, fallback.total)})`);
console.log("");

console.log(`🔁 Week-2 retention (day 7–13)`);
if (!w2Ready) {
  const opensIn = 7 - daysElapsed;
  console.log(
    `   ⏳ ยังวัดไม่ได้ — หน้าต่าง week-2 ` +
      (daysElapsed < 7
        ? `เปิดอีก ${opensIn} วัน (วัน 7 = ${addDays(BROADCAST, 7)})`
        : `กำลังเปิดอยู่ (ปิดวัน 13 = ${addDays(BROADCAST, 13)}); ตัวเลขด้านล่าง partial`),
  );
}
console.log(`   กลับมาใน week-2     ${all.w1retained.length}/${all.w1.length} ของคนที่ลอง week-1 (${pct(all.w1retained.length, all.w1.length)})`);
console.log("");

// First-message signal: did they open with the "do you know me" demo?
const firsts = all.tried.map((r) => act.get(r.email).first || "");
const knowFirst = firsts.filter((s) => RE_KNOW.test(s)).length;
console.log(`💬 ข้อความแรกหลัง broadcast`);
console.log(`   เปิดด้วยคำถามแนว "รู้จักผมไหม/ชื่อเล่น"  ${knowFirst}/${firsts.length} (${pct(knowFirst, firsts.length)})`);
console.log("");

if (LIST) {
  console.log(`👤 คนที่ลอง (${all.tried.length})`);
  for (const r of all.tried.sort((a, b) => act.get(a.email).firstTs - act.get(b.email).firstTs)) {
    const a = act.get(r.email);
    const days = [...a.days].sort((x, y) => x - y).join(",");
    const tag = r.variant === "matched" ? "M" : "f";
    console.log(`   [${tag}] ${(r.nickname || r.name || r.email).padEnd(16)} days=${days.padEnd(10)} first="${(a.first || "").slice(0, 40)}"`);
  }
}

function addDays(isoDay, n) {
  return new Date(Date.parse(isoDay + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}
