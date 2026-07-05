// Seed/refresh the KB cache: pull from Outline → assemble → store in Redis.
// Run after deploy (initial seed) or any time you want to force a refresh
// without using the Teams /refresh command.
//
//   npm run refresh-kb
//
// .env is loaded first so src/env.ts can read the keys at import time.
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { refreshKB } = await import("../src/kb/index.js");
const { refreshDirectory } = await import("../src/people/directory.js");

console.log("กำลังดึงความรู้จาก Outline → Redis ...");
const r = await refreshKB();
console.log("เสร็จแล้ว ✅");
console.log(`  refreshedAt: ${r.refreshedAt}`);
console.log(`  HR:      ${r.counts.hr} เอกสาร`);
console.log(`  Process: ${r.counts.process} เอกสาร`);
console.log(`  Product: ${r.counts.product} เอกสาร`);

console.log("กำลังดึงทะเบียนพนักงานจาก SharePoint (Graph) → Redis ...");
try {
  const d = await refreshDirectory();
  console.log(`  Directory: ${d.people} คน ✅`);
} catch (err) {
  console.error(`  Directory: ล้มเหลว (KB ไม่กระทบ) —`, err instanceof Error ? err.message : err);
}
