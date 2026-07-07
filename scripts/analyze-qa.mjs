// Analyze real user Q&A from Langfuse traces.
// Usage: node scripts/analyze-qa.mjs [days=2] [--raw]
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const DAYS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 2;
const RAW = process.argv.includes("--raw");

const PUB = process.env.LANGFUSE_PUBLIC_KEY;
const SEC = process.env.LANGFUSE_SECRET_KEY;
const HOST = (process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
if (!PUB || !SEC) {
  console.error("Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${PUB}:${SEC}`).toString("base64");
const fromDate = new Date(Date.now() - DAYS * 864e5);

async function apiFetch(path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${HOST}${path}`, { headers: { Authorization: AUTH } });
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
}

// Fetch all traces in the window
async function fetchAllTraces() {
  const all = [];
  for (let page = 1; ; page++) {
    const url = `/api/public/traces?limit=100&page=${page}&fromTimestamp=${encodeURIComponent(fromDate.toISOString())}`;
    const body = await apiFetch(url);
    const data = body.data || [];
    all.push(...data);
    const totalPages = body.meta?.totalPages ?? 1;
    process.stderr.write(`\rfetched page ${page}/${totalPages} traces (${all.length} total)`);
    if (page >= totalPages || data.length === 0) break;
  }
  process.stderr.write("\n");
  return all;
}

// Get trace detail (observations/messages)
async function fetchTraceDetail(traceId) {
  const body = await apiFetch(`/api/public/traces/${traceId}`);
  return body;
}

const allTraces = await fetchAllTraces();

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

// Fetch trace details for real users (limit to avoid rate limits)
console.log("\n=== Fetching trace details for Q&A content ===");
const sampleTraces = realUserTraces.slice(0, Math.min(realUserTraces.length, 100));
const details = [];

for (let i = 0; i < sampleTraces.length; i++) {
  process.stderr.write(`\rfetching detail ${i + 1}/${sampleTraces.length}`);
  try {
    const detail = await fetchTraceDetail(sampleTraces[i].id);
    details.push({ trace: sampleTraces[i], detail });
  } catch (e) {
    process.stderr.write(` [error: ${e.message}]`);
  }
  // small delay to be nice to the API
  if (i % 10 === 9) await new Promise((r) => setTimeout(r, 300));
}
process.stderr.write("\n");

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

  // Also try from observations
  if (!userMsg && detail.observations) {
    for (const obs of detail.observations) {
      if (obs.input && !userMsg) {
        const inp = obs.input;
        if (Array.isArray(inp)) {
          const userPart = inp.filter((m) => m?.role === "user").pop();
          if (userPart) userMsg = typeof userPart.content === "string" ? userPart.content : JSON.stringify(userPart.content).slice(0, 500);
        }
      }
    }
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
