// Broadcast control CLI (manual counterpart to the cron endpoint).
//
//   # 1. Build/refresh the roster (Graph → Redis) and export a CSV for HR:
//   npx tsx scripts/broadcast.ts --campaign launch-2026-07 --build-roster
//
//   # 2. Dry-run the send (counts only, sends nothing):
//   npx tsx scripts/broadcast.ts --campaign launch-2026-07 --send --dry-run
//
//   # 3. Send for real (idempotent; safe to re-run — skips anyone already sent).
//   #    Prefer to just arm the cron in prod; use this for a one-off / to yourself.
//   npx tsx scripts/broadcast.ts --campaign launch-2026-07 --send
//
// The roster CSV (email, nickname, variant, risk) is what you hand HR to validate
// names + approve the message before arming the cron.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { values: args } = parseArgs({
  options: {
    campaign: { type: "string", default: "launch-2026-07" },
    "build-roster": { type: "boolean", default: false },
    send: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    csv: { type: "string" },
  },
});

const campaign = args.campaign;
const { buildRoster, runBroadcast } = await import("../src/channels/broadcast.ts");

if (args["build-roster"]) {
  console.log(`สร้าง roster ของ campaign "${campaign}" (Graph → Redis) ...`);
  const s = await buildRoster(campaign);
  console.log(`  จะส่ง ${s.total} คน · personalize ได้ ${s.matched} · fallback ${s.fallback} · ตัดออก ${s.excluded.length}`);

  if (s.excluded.length) {
    console.log(`\n🚫 ตัดออกจากการส่ง (${s.excluded.length}) — ลาออก/service/ระบุตัวไม่ได้:`);
    for (const e of s.excluded) console.log(`   [${e.reason}] ${e.email || e.aadId}${e.name ? ` (${e.name})` : ""}`);
  }

  const risky = s.rows.filter((r) => r.risk);
  if (risky.length) {
    console.log(`\n⚠️  ชื่อเล่นที่ควรให้ HR ตรวจ (${risky.length}):`);
    for (const r of risky) console.log(`   [${r.risk}] ${r.email} → "${r.nickname}"`);
  }
  const fb = s.rows.filter((r) => r.variant === "fallback");
  if (fb.length) {
    console.log(`\nℹ️  คนที่จะได้เวอร์ชัน fallback (ไม่อยู่ใน directory) — ${fb.length}:`);
    for (const r of fb) console.log(`   ${r.email || r.aadId}${r.name ? ` (${r.name})` : ""}`);
  }

  const csvPath = args.csv ?? `test-results/broadcast-roster-${campaign}.csv`;
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  const esc = (v: string) => `"${(v ?? "").replace(/"/g, "'")}"`;
  const lines = [
    "email,name,nickname,variant,risk",
    ...s.rows.map((r) => [r.email, r.name, r.nickname, r.variant, r.risk].map(esc).join(",")),
  ];
  fs.writeFileSync(csvPath, "﻿" + lines.join("\n"), "utf8"); // BOM so Excel reads Thai
  console.log(`\n📄 เขียน roster CSV ให้ HR ตรวจที่: ${csvPath}`);
}

if (args.send) {
  const dryRun = args["dry-run"];
  console.log(`\n${dryRun ? "DRY-RUN" : "ส่งจริง"} campaign "${campaign}" ...`);
  const res = await runBroadcast(campaign, { dryRun });
  console.log(
    `  attempted ${res.attempted} · ${dryRun ? "จะส่ง" : "ส่งแล้ว"} ${res.sent} · ข้าม(ส่งไปแล้ว) ${res.skipped} · ล้มเหลว ${res.failed}`
  );
  if (dryRun) console.log("  (dry-run — ไม่ได้ส่งจริง เอา --dry-run ออกเพื่อส่ง)");
}

if (!args["build-roster"] && !args.send) {
  console.log("ระบุ --build-roster และ/หรือ --send (ดูหัวไฟล์สำหรับตัวอย่าง)");
}
