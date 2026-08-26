// Analyze real user Q&A from Langfuse traces.
// Usage: npx tsx scripts/analyze-qa.mjs [days=2] [--raw]
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 2;
const RAW = process.argv.includes("--raw");

const PUB = process.env.LANGFUSE_PUBLIC_KEY;
const SEC = process.env.LANGFUSE_SECRET_KEY;
const HOST = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
if (!PUB || !SEC) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}
const fromDate = new Date(Date.now() - DAYS * 864e5);
const { fetchTraces } = await import("../src/analytics/langfuse.ts");
const allTraces = await fetchTraces(
  { host: HOST, publicKey: PUB, secretKey: SEC },
  { fromMs: fromDate.getTime(), toMs: Date.now() },
);

// Filter: only real user emails (contains @)
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const realUserTraces = allTraces.filter((t) => t.userId && EMAIL_RE.test(t.userId));

console.log(`\n=== Langfuse Q&A Analysis — last ${DAYS}d (from ${fromDate.toISOString().slice(0,10)}) ===`);
console.log(`Total traces: ${allTraces.length}  |  Real-user traces: ${realUserTraces.length}\n`);

// User activity summary
const byUser = new Map();
for (const t of realUserTraces) {
  if (!byUser.has(t.userId)) byUser.set(t.userId, []);
  byUser.get(t.userId).push(t);
}
console.log("=== User Activity ===");
const sortedUsers = [...byUser.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [email, traces] of sortedUsers) {
  console.log(`  ${email}: ${traces.length} turns`);
}

// Root observation I/O replaces the removed trace-detail endpoint.
const sampleTraces = realUserTraces.slice(0, Math.min(realUserTraces.length, 100));
const details = sampleTraces.map((trace) => ({ trace, detail: trace }));

// Extract user messages and BOB responses
const qaPairs = [];
for (const { trace, detail } of details) {
  // The trace input is usually the user message
  let userMsg = null;
  let bobResponse = null;

  // Try to get from trace input/output
  if (detail.input) {
    if (typeof detail.input === "string") userMsg = detail.input;
    else if (Array.isArray(detail.input)) {
      const last = detail.input.filter((m) => m?.role === "user").pop();
      if (last) userMsg = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    } else if (detail.input?.text) {
      userMsg = detail.input.text;
    } else if (detail.input?.message) {
      userMsg = detail.input.message;
    }
  }
  if (detail.output) {
    if (typeof detail.output === "string") bobResponse = detail.output;
    else if (detail.output?.text) bobResponse = detail.output.text;
    else if (detail.output?.content) bobResponse = detail.output.content;
    else bobResponse = JSON.stringify(detail.output).slice(0, 300);
  }

  qaPairs.push({
    traceId: trace.id,
    userId: trace.userId,
    timestamp: trace.timestamp,
    userMsg: userMsg?.slice(0, 500) || "(no input found)",
    bobResponse: bobResponse?.slice(0, 300) || "(no output found)",
    tags: detail.tags || trace.tags || [],
    scores: detail.scores || [],
  });
}

if (RAW && qaPairs[0]) {
  console.log("\nRAW FIRST TRACE DETAIL:");
  console.log(JSON.stringify(details[0]?.detail, null, 2));
}

console.log("\n=== All Q&A Turns (sorted by time) ===\n");
const sorted = [...qaPairs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

for (const qa of sorted) {
  const ts = new Date(qa.timestamp).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
  console.log(`[${ts}] ${qa.userId}`);
  console.log(`  Q: ${qa.userMsg}`);
  console.log(`  A: ${qa.bobResponse}`);
  if (qa.tags.length) console.log(`  tags: ${qa.tags.join(", ")}`);
  console.log();
}

// Topic/keyword frequency
console.log("=== Topic Keywords (user questions) ===");
const keywords = {};
const TOPIC_PATTERNS = [
  ["ลา", "วันลา", "leave"],
  ["วันหยุด", "holiday"],
  ["OT", "โอที", "ล่วงเวลา"],
  ["เงินเดือน", "salary", "pay"],
  ["HR", "human resource"],
  ["นโยบาย", "policy"],
  ["Pojjaman", "ERP", "timesheet"],
  ["ประกัน", "insurance"],
  ["สวัสดิการ", "benefit"],
  ["ลาป่วย", "sick leave"],
  ["ลาพักร้อน", "annual leave"],
  ["ลากิจ", "personal leave"],
  ["ทดลองงาน", "probation"],
  ["ลาออก", "resign"],
  ["สัญญา", "contract"],
  ["Builk", "บริษัท"],
  ["เวลา", "time", "ชั่วโมง"],
];
for (const qa of qaPairs) {
  const q = (qa.userMsg || "").toLowerCase();
  for (const group of TOPIC_PATTERNS) {
    if (group.some((kw) => q.includes(kw.toLowerCase()))) {
      const label = group[0];
      keywords[label] = (keywords[label] || 0) + 1;
    }
  }
}
const sortedKw = Object.entries(keywords).sort((a, b) => b[1] - a[1]);
for (const [kw, count] of sortedKw) {
  console.log(`  ${kw}: ${count}`);
}

console.log(`\nTotal Q&A analyzed: ${qaPairs.length}`);
