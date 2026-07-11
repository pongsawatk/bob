// WP-22.2 — response composer + deterministic name/email post-check.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { compose, postCheck, templateFallback, serializeFacts } = await import(
  "../src/people/responder/compose.ts"
);
import type { SearchResult } from "../src/people/retrieval/rank.ts";
import type { LlmCall } from "../src/people/intent/extract.ts";

const A: SearchResult = { kind: "directory", profile: { displayName: "สมชาย ใจดี", nickname: "ชาย", email: "somchai@builk.com", position: "Dev", subOrg: "Engineering" }, reasonCode: "nickname_match" };
const results = [A];
const knownNames = ["สมชาย ใจดี", "ชาย", "อลิส ทดสอบ", "อลิส"]; // อลิส is NOT in results

const constLlm = (s: string): LlmCall => async () => s;

test("clean LLM output passes the post-check", async () => {
  const r = await compose({ results, query: "พี่ชายอยู่ทีมไหน", llm: constLlm("พี่ชาย (สมชาย ใจดี) อยู่ทีม Engineering ครับ ติดต่อ somchai@builk.com ได้เลย"), knownNames });
  assert.equal(r.usedFallback, false);
  assert.match(r.text, /Engineering/);
});

test("leaked email → fallback", async () => {
  const r = await compose({ results, query: "q", llm: constLlm("ลองติดต่อ intruder@builk.com ดูครับ"), knownNames });
  assert.equal(r.usedFallback, true);
  assert.match(r.reason ?? "", /leaked_email/);
});

test("names another directory person → fallback", async () => {
  const r = await compose({ results, query: "q", llm: constLlm("คุณอลิส น่าจะช่วยได้ครับ"), knownNames });
  assert.equal(r.usedFallback, true);
  assert.equal(r.reason, "leaked_name");
});

test("empty results → no_results fallback; llm throwing → template", async () => {
  const empty = await compose({ results: [], query: "q", llm: constLlm("x") });
  assert.deepEqual([empty.usedFallback, empty.reason], [true, "no_results"]);
  const threw = await compose({ results, query: "q", llm: (async () => { throw new Error("boom"); }) as LlmCall, knownNames });
  assert.equal(threw.usedFallback, true);
  assert.match(threw.text, /สมชาย/); // template built from facts
});

test("postCheck: clean passes, serializeFacts has no personId, template lists people", () => {
  assert.equal(postCheck("พี่ชายครับ", results, knownNames).ok, true);
  const facts = serializeFacts(results);
  assert.ok(!/personId|sourceEmployeeId/.test(facts));
  assert.match(facts, /somchai@builk.com/);
  assert.match(templateFallback(results), /สมชาย ใจดี \(ชาย\)/);
  assert.match(templateFallback([]), /ยังไม่พบ/);
});
