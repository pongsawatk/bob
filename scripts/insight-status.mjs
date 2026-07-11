// Maintenance — print a /insight job record (status, stage, error, windows) from Redis.
//   npx tsx scripts/insight-status.mjs <jobId>
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const jobId = process.argv[2];
if (!jobId) { console.error("usage: insight-status.mjs <jobId>"); process.exit(1); }

const { getRedis } = await import("../src/store/redis.ts");
const r = getRedis();
if (!r) { console.error("Redis not configured"); process.exit(1); }

const job = await r.get(`bob:insight:job:${jobId}`);
if (!job) { console.log(`job ${jobId} not found (cleared/expired?)`); process.exit(0); }
console.log(JSON.stringify(job, null, 2));
