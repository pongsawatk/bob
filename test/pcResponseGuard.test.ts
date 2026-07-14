// WP-03 — deterministic response guard & pagination.
// Characterization of P0-3/P0-4: postCheck only ever guarded the *additive*
// direction (names/emails the model invented). Nothing stopped the model from
// denying results that retrieval had actually found ("ทีม DX มีใครบ้าง" → rc=20 but
// "ไม่พบทีม DX"), and nothing made a truncated roster disclose that it was truncated
// ("พบ 20 คน" when 29 matched). Both are now validator failures that fall back to a
// deterministic template.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { validateResponse, countTemplate, rosterTemplate, compose } = await import(
  "../src/people/responder/compose.ts"
);
import type { SearchResult } from "../src/people/retrieval/rank.ts";

const R = (displayName: string, email: string, position?: string): SearchResult => ({
  kind: "directory",
  profile: { displayName, email, position, subOrg: "DX" },
  reasonCode: "team_member",
});

const three = [R("กอ หนึ่ง", "q1@x.com", "QA Engineer"), R("ขอ สอง", "q2@x.com", "QA Engineer"), R("คอ สาม", "q3@x.com", "QA Engineer")];

const ctx = (over: Partial<Parameters<typeof validateResponse>[1]> = {}) => ({
  results: three,
  knownNames: [],
  totalMatches: 3,
  shownCount: 3,
  truncated: false,
  countOnly: false,
  ...over,
});

// ── The P0-3 regression: responder contradicting retrieval ───────────────

test("rejects a no-result answer when candidates are non-empty (Thai)", () => {
  const v = validateResponse("ขออภัยครับ ไม่พบทีม DX ในทะเบียนครับ", ctx());
  assert.equal(v.ok, false);
  assert.equal(v.reason, "no_result_contradiction");
});

test("rejects a no-result answer when candidates are non-empty (English)", () => {
  const v = validateResponse("I could not find anyone on team DX.", ctx());
  assert.equal(v.ok, false);
  assert.equal(v.reason, "no_result_contradiction");
});

test("accepts an answer that actually reports the candidates", () => {
  const v = validateResponse("ทีม DX มี 3 คนครับ: กอ หนึ่ง, ขอ สอง, คอ สาม", ctx());
  assert.equal(v.ok, true);
});

// ── countOnly must match totalMatches exactly ────────────────────────────

test("rejects a count answer that states the wrong number", () => {
  const v = validateResponse("ทีม DX มี QA 5 คนครับ", ctx({ countOnly: true, results: [], shownCount: 0 }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, "count_mismatch");
});

test("accepts a count answer that states the exact totalMatches", () => {
  const v = validateResponse("ทีม DX มี QA 3 คนครับ", ctx({ countOnly: true, results: [], shownCount: 0 }));
  assert.equal(v.ok, true);
});

// ── The P0-4 regression: truncation must be disclosed ────────────────────

test("rejects a truncated roster answer that hides the true total", () => {
  const v = validateResponse("ทีม DX มี 3 คนครับ", ctx({ totalMatches: 29, shownCount: 3, truncated: true }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, "truncation_not_disclosed");
});

test("accepts a truncated roster answer that discloses total and shown", () => {
  const v = validateResponse(
    "พบทั้งหมด 29 คนครับ แสดง 3 คนแรก",
    ctx({ totalMatches: 29, shownCount: 3, truncated: true }),
  );
  assert.equal(v.ok, true);
});

// ── Existing additive guard still enforced through the same entry point ──

test("still rejects an email outside the candidate set", () => {
  const v = validateResponse("ติดต่อ stranger@x.com ได้ครับ", ctx());
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /^leaked_email/);
});

test("still rejects a directory name outside the candidate set", () => {
  const v = validateResponse("ลองถาม สมชาย ใจดี ดูครับ", ctx({ knownNames: ["สมชาย ใจดี"] }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, "leaked_name");
});

// ── Deterministic templates ──────────────────────────────────────────────

test("countTemplate states the exact total and passes its own validator", () => {
  const c = ctx({ countOnly: true, results: [], shownCount: 0, totalMatches: 3, filtersApplied: { team: "DX", role: "QUALITY_ASSURANCE" } });
  const text = countTemplate(c);
  assert.match(text, /3/);
  assert.equal(validateResponse(text, c).ok, true);
});

test("rosterTemplate discloses total vs shown when truncated, and how to see more", () => {
  const c = ctx({ totalMatches: 29, shownCount: 3, truncated: true });
  const text = rosterTemplate(c);
  assert.match(text, /29/);
  assert.match(text, /3/);
  assert.match(text, /ดูต่อ|เพิ่มเติม/);
  assert.equal(validateResponse(text, c).ok, true);
});

test("rosterTemplate does not claim truncation when the roster is complete", () => {
  const c = ctx();
  const text = rosterTemplate(c);
  assert.equal(validateResponse(text, c).ok, true);
  assert.doesNotMatch(text, /ดูต่อ/);
});

// ── compose() falls back deterministically on any validation failure ─────

test("compose discards a contradicting LLM answer and falls back to the template", async () => {
  const res = await compose({
    results: three,
    query: "ทีม DX มีใครบ้าง",
    llm: async () => "ขออภัยครับ ไม่พบทีม DX",
    ...ctx(),
  });
  assert.equal(res.usedFallback, true);
  assert.equal(res.reason, "no_result_contradiction");
  assert.match(res.text, /กอ หนึ่ง/);
});

test("compose keeps a valid LLM answer", async () => {
  const res = await compose({
    results: three,
    query: "ทีม DX มีใครบ้าง",
    llm: async () => "ทีม DX มี กอ หนึ่ง, ขอ สอง และ คอ สาม ครับ",
    ...ctx(),
  });
  assert.equal(res.usedFallback, false);
  assert.match(res.text, /กอ หนึ่ง/);
});
