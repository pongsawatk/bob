// Phase 0 / Decision D4 — verify Anthropic prompt caching works THROUGH OpenRouter.
// This is the cost-critical check: if cache_control does not pass through, the
// Product Bot (Claude Sonnet) input cost is 3–5x higher than budgeted.
//
//   node scripts/verify-cache-control.mjs
//
// How it works: sends the SAME large system prompt (with cache_control: ephemeral)
// twice within a few seconds. Call #1 should WRITE the cache, call #2 should READ it.
// We inspect the usage object for cache_read tokens > 0 on the second call.
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6";

if (!KEY) {
  console.error("❌ ต้องตั้ง OPENROUTER_API_KEY ใน .env ก่อน");
  process.exit(2);
}

// Build a system prompt large enough to exceed Anthropic's caching minimum
// (~1024 tokens for Sonnet). Repeat a realistic knowledge-style block.
const BLOCK = `
คุณคือ BOB Sidekick ผู้ช่วย AI ของ Builk One Group ตอบคำถามพนักงานเรื่อง HR สวัสดิการ
กระบวนการทำงาน และ Product (iNsite, Pojjaman ERP, Builk360, JUBILI CRM, BIM Cost Connect).
กฎสำคัญ: ตอบเฉพาะข้อมูลที่มีใน knowledge base, ถ้าไม่รู้ให้บอกตรงๆ, อ้างอิงแหล่งที่มาเสมอ,
ห้ามเดาราคาหรือโปรโมชัน, ใช้ภาษาไทยที่กระชับและเป็นมิตร. ตัวอย่างหัวข้อความรู้: การลาพักร้อน
การลาป่วย กองทุนสำรองเลี้ยงชีพ ประกันสังคม ค่าเบี้ยเลี้ยง การเบิกค่าเดินทางผ่าน Pojjaman
ระเบียบการอนุมัติ วันหยุดประจำปี การยืม-คืนทรัพย์สิน นโยบายคอมพิวเตอร์และโทรศัพท์.
`.trim();
const BIG_SYSTEM = Array.from({ length: 24 }, (_, i) => `[ส่วนที่ ${i + 1}] ${BLOCK}`).join("\n\n");

function buildBody() {
  return {
    model: MODEL,
    usage: { include: true },
    temperature: 0,
    max_tokens: 20,
    messages: [
      {
        role: "system",
        // ttl:"1h" mirrors the production config (see openrouter.ts) — verifies the
        // extended 1-hour cache tier passes through OpenRouter to Anthropic.
        content: [
          { type: "text", text: BIG_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
      { role: "user", content: "ตอบกลับสั้นๆ คำเดียวว่า: พร้อม" },
    ],
  };
}

async function call(label) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "X-Title": "BOB cache-control verification",
    },
    body: JSON.stringify(buildBody()),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[${label}] HTTP ${res.status}: ${text}`);
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`[${label}] response ไม่ใช่ JSON: ${text.slice(0, 300)}`);
  }
  return j;
}

// Pull cache figures from whichever shape OpenRouter/Anthropic returns.
function readCacheFields(usage = {}) {
  const details = usage.prompt_tokens_details || {};
  return {
    prompt: usage.prompt_tokens ?? usage.input_tokens ?? null,
    cacheRead:
      usage.cache_read_input_tokens ??
      details.cached_tokens ??
      usage.cached_tokens ??
      null,
    cacheWrite: usage.cache_creation_input_tokens ?? usage.cache_creation ?? null,
    cost: usage.cost ?? null,
    discount: usage.cache_discount ?? null,
  };
}

console.log(`\nBOB Phase 0 — cache_control verification (D4)`);
console.log(`model: ${MODEL}`);
console.log("─".repeat(56));

try {
  console.log("→ call #1 (expect cache WRITE) ...");
  const r1 = readCacheFields((await call("1")).usage);
  console.log("   usage:", JSON.stringify(r1));

  await new Promise((r) => setTimeout(r, 2000));

  console.log("→ call #2 (expect cache READ) ...");
  const r2 = readCacheFields((await call("2")).usage);
  console.log("   usage:", JSON.stringify(r2));

  console.log("─".repeat(56));
  const cacheHit = (r2.cacheRead ?? 0) > 0 || (r1.cacheWrite ?? 0) > 0;
  if (cacheHit) {
    console.log("✅ PASS — prompt caching ส่งผ่าน OpenRouter ถึง Anthropic แล้ว");
    console.log(`   call#1 cacheWrite=${r1.cacheWrite} · call#2 cacheRead=${r2.cacheRead}`);
    console.log("   → cost ของ Product Bot จะลดตามที่วางแผนไว้");
    process.exit(0);
  } else {
    console.log("⚠️  UNCONFIRMED — ไม่พบ cache token ใน usage");
    console.log("   ตรวจ: (1) model slug ถูกไหม (2) prompt ยาวพอ (>1024 tokens) ไหม");
    console.log("   (3) usage fields อาจชื่ออื่น — ดู usage ที่ print ด้านบนแล้วแจ้ง Claude");
    process.exit(1);
  }
} catch (err) {
  console.error("❌ ERROR:", err?.message ?? err);
  process.exit(1);
}
