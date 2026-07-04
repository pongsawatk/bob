// BOB Eval Runner — regression guard for KB/prompt changes (esp. before shrinking
// the HR bundle). Runs cases through the LOCAL pipeline (no Teams), grades each with
// (1) rule-based asserts and (2) an LLM judge (deepseek), and can diff vs a baseline.
//
//   npx tsx scripts/run-eval.mjs                         # full run (judge on)
//   npx tsx scripts/run-eval.mjs --nojudge               # rule-based only (free-ish)
//   npx tsx scripts/run-eval.mjs --limit 5               # first 5 cases (smoke)
//   npx tsx scripts/run-eval.mjs --baseline test-results/eval-XXXX.jsonl   # diff
//
// Must run under tsx (imports .ts). Each case = 1 domain LLM call (+1 cheap judge).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { values: args } = parseArgs({
  options: {
    cases: { type: "string", default: "test-cases/bob-eval-hr.jsonl" },
    out: { type: "string", default: `test-results/eval-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl` },
    baseline: { type: "string" },
    nojudge: { type: "boolean", default: false },
    limit: { type: "string" },
    "judge-model": { type: "string", default: process.env.MODEL_EVAL || process.env.MODEL_ASYNC || "deepseek/deepseek-v4-flash" },
  },
});

const { runPipeline } = await import("../src/pipeline/index.ts");
const { callLLM } = await import("../src/llm/openrouter.ts");
const { remainingHolidaysBlock } = await import("../src/kb/holidays.ts");

const REFUSAL = /ขออภัย|ไม่มีข้อมูล|ยังไม่มี|ไม่ได้มีข้อมูล|เข้าไม่ถึง|ไม่มีสิทธิ์เข้าถึง|HumanSoft|ติดต่อ\s*(HR|Sales|Finance|IT|ทีม|Pre-?sales|Product|ผู้บริหาร)|แนะนำให้.*(ถาม|ติดต่อ|ปรึกษา)/i;

function expectedHolidayCount() {
  const m = remainingHolidaysBlock().match(/ทั้งหมด (\d+) วัน/);
  return m ? m[1] : null;
}

// ── Rule-based checks → returns list of failure strings ──────────────
function ruleCheck(tc, answer, category) {
  const fails = [];
  if (tc.expect_category && category !== tc.expect_category)
    fails.push(`category: expected ${tc.expect_category}, got ${category}`);
  for (const s of tc.must_contain || [])
    if (!answer.includes(s)) fails.push(`missing "${s}"`);
  for (const s of tc.must_not_contain || [])
    if (answer.includes(s)) fails.push(`must-not-contain leaked "${s}"`);
  if (tc.expect_refuse && !REFUSAL.test(answer))
    fails.push("expected a refusal/deflection but none found");
  if (tc.assert_holiday_count) {
    const c = expectedHolidayCount();
    if (c && !answer.includes(`${c} วัน`)) fails.push(`holiday count: expected "${c} วัน" in answer`);
  }
  return fails;
}

// ── LLM judge (deepseek) → { score 1-5, reason } ────────────────────
async function judge(tc, answer, attempt = 1) {
  const sys =
    "คุณเป็นผู้ตรวจคุณภาพคำตอบของแชทบอท HR ภายในองค์กร ประเมินอย่างเข้มงวดและยุติธรรม ตอบเป็น JSON เท่านั้น";
  const user =
    `คำถามผู้ใช้:\n${tc.question}\n\nคำตอบของบอท:\n${answer}\n\n` +
    `เกณฑ์การประเมิน:\n${tc.judge}\n\n` +
    `ให้คะแนน 1-5 (5=ตรงคำถาม ถูกต้อง grounded ตามเกณฑ์; 3=พอใช้/ไม่ครบ; 1=ผิด/มั่ว/ไม่ตรงคำถาม). ` +
    `ตอบ JSON เท่านั้น (บรรทัดเดียว): {"score": <1-5>, "reason": "<สั้นๆ ไทย>"}`;
  let r;
  try {
    r = await callLLM({
      model: args["judge-model"],
      systemPrompt: sys,
      messages: [{ role: "user", content: user }],
      maxTokens: 800, // headroom in case the judge model emits reasoning before the JSON
      temperature: 0,
    });
  } catch (err) {
    // callLLM throws on empty content (guards blank cards in Teams) — but for the
    // judge an empty completion is routine (deepseek sometimes burns all tokens on
    // reasoning). Retry once, then fall back to rules-only, same as garbled JSON.
    if (attempt < 2) return judge(tc, answer, attempt + 1);
    return { score: null, reason: `judge unavailable: ${String(err).slice(0, 80)}` };
  }
  const match = r.text.match(/\{[\s\S]*\}/); // grab the JSON object even if prefixed by reasoning
  if (match) {
    try {
      const j = JSON.parse(match[0]);
      if (j && j.score != null) return { score: Number(j.score), reason: j.reason || "" };
    } catch {}
  }
  if (attempt < 2) return judge(tc, answer, attempt + 1); // retry once on empty/garbled
  // Judge genuinely unavailable → don't fabricate a failing score; fall back to rules only.
  return { score: null, reason: `judge unavailable: "${r.text.slice(0, 80)}"` };
}

function severityOf(tc, ruleFails, judged) {
  if (tc.critical && ruleFails.some((f) => f.includes("must-not-contain"))) return "FAIL_CRITICAL";
  if (ruleFails.length) return "FAIL";
  if (judged && judged.score != null) {
    if (judged.score <= 2) return "FAIL";
    if (judged.score === 3) return "WARN";
  }
  return "PASS";
}

async function main() {
  const casesPath = path.resolve(args.cases);
  let cases = fs.readFileSync(casesPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (args.limit) cases = cases.slice(0, Number(args.limit));

  let base = null;
  if (args.baseline) {
    base = new Map();
    for (const l of fs.readFileSync(args.baseline, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l);
      base.set(r.id, { severity: r.severity, score: r.judge?.score ?? null });
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  const outStream = fs.createWriteStream(args.out, { flags: "w" });
  console.log(`▶️  ${cases.length} cases | judge=${args.nojudge ? "off" : args["judge-model"]}\n`);

  const sum = { PASS: 0, WARN: 0, FAIL: 0, FAIL_CRITICAL: 0 };
  const regressions = [];

  for (const tc of cases) {
    let answer = "", category = "ERROR", err = null;
    try {
      const res = await runPipeline({ message: tc.question, userId: "eval", userName: "Eval", department: "QA" });
      answer = (res.answer || "").toString();
      category = res.category;
    } catch (e) {
      err = e?.message ?? String(e);
    }

    const ruleFails = err ? [`pipeline error: ${err}`] : ruleCheck(tc, answer, category);
    const judged = !args.nojudge && !err ? await judge(tc, answer) : null;
    const severity = err ? "FAIL" : severityOf(tc, ruleFails, judged);
    sum[severity] = (sum[severity] || 0) + 1;

    const row = { id: tc.id, severity, category, ruleFails, judge: judged, note: tc.note, answer: answer.slice(0, 300) };
    outStream.write(JSON.stringify(row) + "\n");

    const icon = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", FAIL_CRITICAL: "🔴" }[severity];
    const jtxt = judged ? (judged.score != null ? ` judge=${judged.score}/5` : " judge=NA") : "";
    console.log(`${icon} ${tc.id.padEnd(16)} ${severity}${jtxt}${ruleFails.length ? " — " + ruleFails.join("; ") : ""}`);
    if (judged && (judged.score == null || judged.score <= 3)) console.log(`      ↳ ${judged.reason}`);

    if (base?.has(tc.id)) {
      const b = base.get(tc.id);
      const rank = { PASS: 3, WARN: 2, FAIL: 1, FAIL_CRITICAL: 0 };
      if (rank[severity] < rank[b.severity]) regressions.push(`${tc.id}: ${b.severity} → ${severity}`);
    }
  }
  outStream.end();

  const total = cases.length;
  console.log(`\n=== EVAL SUMMARY ===`);
  console.log(`✅ PASS ${sum.PASS}/${total}  ⚠️ WARN ${sum.WARN}  ❌ FAIL ${sum.FAIL}  🔴 CRITICAL ${sum.FAIL_CRITICAL}`);
  console.log(`Output: ${args.out}`);
  if (base) {
    if (regressions.length) {
      console.log(`\n🚫 REGRESSIONS vs baseline (${regressions.length}):`);
      regressions.forEach((r) => console.log(`   - ${r}`));
      process.exit(2);
    }
    console.log(`\n✅ No regressions vs baseline.`);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
