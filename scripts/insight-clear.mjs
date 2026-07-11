// Maintenance — clear all /insight job state from Redis (jobs, idempotency, claims,
// stored state/reports) so stuck or test jobs can be re-run without waiting for TTL.
// Safe: only touches bob:insight:* keys. Read-only to everything else.
//   npx tsx scripts/insight-clear.mjs        # clear all
//   npx tsx scripts/insight-clear.mjs --dry  # list what would be cleared
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const DRY = process.argv.includes("--dry");
const { getRedis } = await import("../src/store/redis.ts");
const r = getRedis();
if (!r) { console.error("Redis not configured (.env)"); process.exit(1); }

const keys = await r.keys("bob:insight:*");
if (!keys.length) { console.log("no bob:insight:* keys found — nothing to clear"); process.exit(0); }

console.log(`${DRY ? "[dry-run] would clear" : "clearing"} ${keys.length} keys:`);
for (const k of keys) console.log("  " + k);
if (DRY) process.exit(0);

for (const k of keys) await r.del(k);
console.log(`\n✅ cleared ${keys.length} keys — /insight can be run fresh now`);
