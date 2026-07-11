// WP-21.1 — intent extraction with a mocked LLM. Pins JSON parsing, enum
// validation, searchParams normalization, one-retry-then-low-confidence, and the
// schema hint in the user message. No network.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { extractIntent, buildUserMessage, FALLBACK_INTENT } = await import("../src/people/intent/extract.ts");
import type { LlmCall } from "../src/people/intent/extract.ts";
import { SUB_INTENTS } from "../src/people/pcTypes.ts";

/** Mock returning canned responses in order; records the calls it received. */
function mockLlm(...responses: string[]): LlmCall & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (user: string) => {
    calls.push(user);
    return responses[calls.length - 1] ?? responses[responses.length - 1] ?? "";
  }) as LlmCall & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("valid JSON for every sub-intent passes through", async () => {
  for (const si of SUB_INTENTS) {
    const llm = mockLlm(JSON.stringify({ subIntent: si, searchParams: { topic: "x" }, confidence: 0.9 }));
    const r = await extractIntent("q", llm);
    assert.equal(r.subIntent, si);
    assert.equal(r.confidence, 0.9);
    assert.equal(llm.calls.length, 1);
  }
});

test("strips ```json code fences", async () => {
  const llm = mockLlm('```json\n{"subIntent":"OWNER_LOOKUP","searchParams":{"topic":"Pojjaman"},"confidence":0.9}\n```');
  const r = await extractIntent("ใครดูแล Pojjaman", llm);
  assert.equal(r.subIntent, "OWNER_LOOKUP");
  assert.equal(r.searchParams.topic, "Pojjaman");
});

test("drops unexpected searchParams keys and empty strings (no forced retry)", async () => {
  const llm = mockLlm(
    JSON.stringify({ subIntent: "PERSON_LOOKUP", searchParams: { personRef: " โบ๊ท ", team: "", junk: "x" }, confidence: 0.9 }),
  );
  const r = await extractIntent("พี่โบ๊ท", llm);
  assert.deepEqual(r.searchParams, { personRef: "โบ๊ท" }); // trimmed, team dropped, junk dropped
  assert.equal(llm.calls.length, 1); // did not need a retry
});

test("clamps confidence into [0,1]", async () => {
  const llm = mockLlm(JSON.stringify({ subIntent: "TEAM_ROSTER", searchParams: { team: "Jubili" }, confidence: 1.7 }));
  const r = await extractIntent("ทีม Jubili มีใครบ้าง", llm);
  assert.equal(r.confidence, 1);
});

test("invalid enum first, valid on retry → returns retry (2 calls)", async () => {
  const llm = mockLlm(
    JSON.stringify({ subIntent: "NONSENSE", searchParams: {}, confidence: 0.9 }),
    JSON.stringify({ subIntent: "REPORTING_LINE", searchParams: { personRef: "จ้อ" }, confidence: 0.9 }),
  );
  const r = await extractIntent("หัวหน้าของพี่จ้อคือใคร", llm);
  assert.equal(r.subIntent, "REPORTING_LINE");
  assert.equal(llm.calls.length, 2);
  assert.ok(llm.calls[1]?.includes("JSON ที่ถูกต้อง")); // retry hint appended
});

test("garbage twice → FALLBACK at confidence 0 (→ policy UNABLE → clarify)", async () => {
  const llm = mockLlm("not json at all", "still not json");
  const r = await extractIntent("???", llm);
  assert.equal(r.confidence, 0);
  assert.equal(r.subIntent, FALLBACK_INTENT.subIntent);
  assert.deepEqual(r.searchParams, {});
  assert.equal(llm.calls.length, 2);
});

test("non-numeric confidence is rejected → retry", async () => {
  const llm = mockLlm(
    JSON.stringify({ subIntent: "OWNER_LOOKUP", searchParams: { topic: "X" }, confidence: "high" }),
    JSON.stringify({ subIntent: "OWNER_LOOKUP", searchParams: { topic: "X" }, confidence: 0.8 }),
  );
  const r = await extractIntent("ใครดูแล X", llm);
  assert.equal(r.confidence, 0.8);
  assert.equal(llm.calls.length, 2);
});

test("buildUserMessage carries the schema hint and recent history", () => {
  const msg = buildUserMessage("มีคนอื่นอีกไหม", [
    { role: "user", content: "ใครดูแล Pojjaman" },
    { role: "assistant", content: "คุณสมชายครับ" },
  ]);
  assert.ok(msg.includes("subIntent"));
  assert.ok(msg.includes("ใครดูแล Pojjaman"));
  assert.ok(msg.includes("คำถามล่าสุด: มีคนอื่นอีกไหม"));
});
