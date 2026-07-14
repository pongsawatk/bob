// WP-07 — observability & error taxonomy.
// `usedFallback` was a single boolean covering every degradation, so a trace could not
// distinguish "the extractor couldn't parse the question" from "that person isn't in
// the registry" from "we couldn't tell who was asking" — every no-result looked the
// same and none of them were actionable. And PEOPLE turns logged no generation at all,
// so the one category running two LLM calls reported no tokens and no cost.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { handlePeopleQuery } = await import("../src/people/connector.ts");
import type { Profile } from "../src/people/directory.ts";

const directory: Record<string, Profile> = {
  "me@x.com": { email: "me@x.com", fullNameTh: "ฉัน เอง", subOrg: "DX", position: "QA Engineer", supervisor: "หัวหน้า ใหญ่" },
  "boss@x.com": { email: "boss@x.com", fullNameTh: "หัวหน้า ใหญ่", subOrg: "DX", position: "Head" },
};

const deps = (over: Record<string, unknown> = {}) => ({
  intentLlm: async () => JSON.stringify({ subIntent: "TEAM_ROSTER", searchParams: { team: "DX" }, confidence: 0.9 }),
  responderLlm: async () => "ทีม DX มี ฉัน เอง และ หัวหน้า ใหญ่ ครับ",
  getDirectory: async () => directory,
  getKnownNames: async () => [],
  ...over,
});

// ── Error taxonomy: each answerless turn names its own stage ─────────────

test("an unparseable question reports INTENT_FALLBACK, not a generic clarify", async () => {
  const res = await handlePeopleQuery("???", deps({ intentLlm: async () => "I am not JSON at all" }));
  assert.equal(res.errorStage, "INTENT_FALLBACK");
  assert.equal(res.intentFallback, true);
});

test("a genuinely vague question reports POLICY_CLARIFY, a different problem", async () => {
  const res = await handlePeopleQuery("ใครสักคน", deps({
    intentLlm: async () => JSON.stringify({ subIntent: "TEAM_DISCOVERY", searchParams: {}, confidence: 0.2 }),
  }));
  assert.equal(res.errorStage, "POLICY_CLARIFY");
  assert.notEqual(res.intentFallback, true, "the extractor worked fine — the question was vague");
});

test("a real search miss reports NO_RESULT + retrievalFallback", async () => {
  const res = await handlePeopleQuery("ทีม Nonexistent มีใครบ้าง", deps({
    intentLlm: async () => JSON.stringify({ subIntent: "TEAM_ROSTER", searchParams: { team: "Nonexistent" }, confidence: 0.9 }),
  }));
  assert.equal(res.errorStage, "NO_RESULT");
  assert.equal(res.retrievalFallback, true);
  assert.notEqual(res.intentFallback, true);
});

test("an unidentifiable asker reports IDENTITY, never NO_RESULT", async () => {
  const res = await handlePeopleQuery("หัวหน้าฉันคือใคร", deps({
    intentLlm: async () => JSON.stringify({ subIntent: "REPORTING_LINE", searchParams: {}, confidence: 0.9 }),
  }), {});
  assert.equal(res.errorStage, "IDENTITY");
  assert.equal(res.identityOutcome, "IDENTITY_NOT_FOUND");
});

test("a refusal reports POLICY_REFUSE", async () => {
  const res = await handlePeopleQuery("เงินเดือนของ หัวหน้า ใหญ่ เท่าไหร่", deps());
  assert.equal(res.errorStage, "POLICY_REFUSE");
  assert.equal(res.outcome, "REFUSE");
});

test("a responder fighting retrieval reports RESPONDER_VALIDATION_FAILED", async () => {
  const res = await handlePeopleQuery("ทีม DX มีใครบ้าง", deps({
    responderLlm: async () => "ขออภัยครับ ไม่พบทีม DX",
  }));
  assert.equal(res.errorStage, "RESPONDER_VALIDATION_FAILED");
  assert.equal(res.responderFallback, true);
  assert.equal(res.resultCount, 2, "the answer still ships — from the template");
});

test("a successful turn carries no errorStage", async () => {
  const res = await handlePeopleQuery("ทีม DX มีใครบ้าง", deps());
  assert.equal(res.errorStage, undefined);
  assert.equal(res.responderFallback, undefined);
});

// ── Stage timings ───────────────────────────────────────────────────────

test("stage timings are reported so a slow turn points at a stage", async () => {
  const res = await handlePeopleQuery("ทีม DX มีใครบ้าง", deps());
  assert.ok(typeof res.stages?.intentMs === "number");
  assert.ok(typeof res.stages?.retrievalMs === "number");
  assert.ok(typeof res.stages?.responderMs === "number");
});

test("a self turn reports identity timing separately", async () => {
  const res = await handlePeopleQuery("หัวหน้าฉันคือใคร", deps({
    intentLlm: async () => JSON.stringify({ subIntent: "REPORTING_LINE", searchParams: {}, confidence: 0.9 }),
    responderLlm: async () => "หัวหน้าของคุณคือ หัวหน้า ใหญ่ ครับ",
  }), { requester: { email: "me@x.com" } });
  assert.equal(res.identityOutcome, "SELF_RESOLVED");
  assert.ok(typeof res.stages?.identityMs === "number");
});

// ── Privacy of telemetry ────────────────────────────────────────────────

test("the identity key is pseudonymous — a trace never carries the email", async () => {
  const res = await handlePeopleQuery("หัวหน้าฉันคือใคร", deps({
    intentLlm: async () => JSON.stringify({ subIntent: "REPORTING_LINE", searchParams: {}, confidence: 0.9 }),
    responderLlm: async () => "หัวหน้าของคุณคือ หัวหน้า ใหญ่ ครับ",
  }), { requester: { email: "me@x.com" } });
  assert.ok(res.identityKey);
  assert.doesNotMatch(res.identityKey ?? "", /me@x\.com/i);
});
