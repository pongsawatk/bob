// Prompts B & C — the People intent + responder prompts move to Langfuse so they can
// be edited without a deploy, like router/hr/product/general.
//
// Three layers have to agree or the migration is a silent behavior change:
//   Langfuse `production`  →  prompts/fallback/<name>.txt  →  the inline constant
// A Langfuse outage drops to the file; a missing file drops to the constant. If those
// disagree, an outage quietly becomes a different bot. These tests pin the contract
// that can be checked offline (file == constant) and the placeholder/schema shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { INTENT_SYSTEM_PROMPT, buildUserMessage } = await import("../src/people/intent/extract.ts");
const { RESPONDER_SYSTEM_PROMPT, RESPONDER_SYSTEM_PROMPT: RESP } = await import("../src/people/connector.ts");

const readFallback = (name: string) => readFileSync(join(process.cwd(), "prompts", "fallback", `${name}.txt`), "utf8");

test("people-intent fallback file matches the inline constant exactly", () => {
  assert.equal(readFallback("people-intent").trimEnd(), INTENT_SYSTEM_PROMPT.trimEnd());
});

test("people-responder fallback file matches the inline constant exactly", () => {
  assert.equal(readFallback("people-responder").trimEnd(), RESPONDER_SYSTEM_PROMPT.trimEnd());
});

// ── Intent prompt contract ──────────────────────────────────────────────

test("the intent prompt documents every sub-intent the code accepts", async () => {
  const { SUB_INTENTS } = await import("../src/people/pcTypes.ts");
  const text = readFallback("people-intent");
  for (const s of SUB_INTENTS) {
    assert.ok(text.includes(s), `sub-intent ${s} must be documented in the prompt`);
  }
});

test("the intent prompt documents every targetType the code accepts", async () => {
  const { TARGET_TYPES } = await import("../src/people/pcTypes.ts");
  const text = readFallback("people-intent");
  for (const t of TARGET_TYPES) {
    assert.ok(text.includes(t), `targetType ${t} must be documented in the prompt`);
  }
});

test("the intent prompt forbids inventing a personRef for a self question", () => {
  const text = readFallback("people-intent");
  assert.match(text, /SELF/);
  assert.match(text, /personRef/);
});

test("the intent prompt carries the self and multi-filter examples the WPs depend on", () => {
  const text = readFallback("people-intent");
  assert.match(text, /หัวหน้าฉันคือใคร/);
  assert.match(text, /"targetType":"SELF"/);
  assert.match(text, /"role":"QA"/);
  assert.match(text, /"countOnly":true/);
});

test("the intent prompt takes no placeholders — the query rides in the user message", () => {
  assert.doesNotMatch(readFallback("people-intent"), /\{\{\w+\}\}/);
  assert.match(buildUserMessage("ทดสอบ"), /คำถามล่าสุด: ทดสอบ/);
});

// ── Responder prompt contract ───────────────────────────────────────────

test("the responder prompt keeps the FACTS-only invariant", () => {
  const text = readFallback("people-responder");
  assert.match(text, /FACTS/);
  assert.match(text, /ห้ามเพิ่มชื่อบุคคล/);
});

test("the responder prompt takes no placeholders — FACTS ride in the user message", () => {
  assert.doesNotMatch(readFallback("people-responder"), /\{\{\w+\}\}/);
});

test("the responder constant is still exported for the compiled-in last resort", () => {
  assert.ok(RESP.length > 0);
});
