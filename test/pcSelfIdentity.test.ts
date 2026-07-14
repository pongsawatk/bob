// WP-01 — self-identity resolution (P0).
// Characterization of the top production bug: "หัวหน้าฉันคือใคร" — the CTA on the
// round-2 broadcast card — returned 0 results for 32/32 turns. Not an LLM flake:
// handlePeopleQuery never received the asker's identity, so REPORTING_LINE fell to
// `if (!norm(ref)) return empty()` because no name was typed. Identity now binds by
// canonical company email (the registry has no AAD object-id column) and the answer
// comes from the requester's own profile.
//
// Synthetic fixture only.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { resolveRequester, identityKey } = await import("../src/people/identity.ts");
const { retrieve } = await import("../src/people/retrieval/search.ts");
const { detectSelfReference } = await import("../src/people/intent/extract.ts");
const { handlePeopleQuery } = await import("../src/people/connector.ts");
import type { Profile } from "../src/people/directory.ts";
import type { IntentResult } from "../src/people/pcTypes.ts";

const P = (email: string, o: Partial<Profile> & { fullNameTh: string }): Profile => ({ ...o, email: email.toLowerCase() });

const BOSS = P("boss@x.com", { fullNameTh: "หัวหน้า ใหญ่", position: "Head of DX", subOrg: "DX" });
const ME = P("me@x.com", { fullNameTh: "ฉัน เอง", nickname: "มี", position: "QA Engineer", subOrg: "DX", startDate: "2020-01-15", supervisor: "หัวหน้า ใหญ่" });
const OTHER = P("other@x.com", { fullNameTh: "คนอื่น เขา", position: "Developer", subOrg: "DX", supervisor: "หัวหน้า ใหญ่" });
const TOP = P("top@x.com", { fullNameTh: "ซีอีโอ สูงสุด", position: "CEO" }); // no supervisor

const directory: Record<string, Profile> = {
  "boss@x.com": BOSS,
  "me@x.com": ME,
  "other@x.com": OTHER,
  "top@x.com": TOP,
};

const NOW = new Date("2026-07-15T03:00:00Z"); // 10:00 Asia/Bangkok

// ── Deterministic self detection (code, not the LLM) ─────────────────────

test("detects Thai first-person pronouns as self-reference", () => {
  for (const q of ["หัวหน้าฉันคือใคร", "หัวหน้าผมคือใคร", "ฉันอยู่ทีมไหน", "ผมทำงานมากี่ปีแล้ว", "ดิฉันอยู่แผนกอะไร"]) {
    assert.equal(detectSelfReference(q), true, `${q} should be self`);
  }
});

test("detects English first-person as self-reference", () => {
  for (const q of ["who is my manager", "what team am I in", "how long have I worked here"]) {
    assert.equal(detectSelfReference(q), true, `${q} should be self`);
  }
});

test("a question about a named person is not self-reference", () => {
  for (const q of ["หัวหน้าของพี่จ้อคือใคร", "พี่โบ๊ทอยู่ทีมไหน", "who is Alice's manager", "ทีม DX มีใครบ้าง"]) {
    assert.equal(detectSelfReference(q), false, `${q} should not be self`);
  }
});

// ── Identity resolution ─────────────────────────────────────────────────

test("resolves the requester by canonical email (case-insensitive)", () => {
  const r = resolveRequester({ servable: directory, all: directory, identity: { email: "ME@x.com" } });
  assert.equal(r.status, "SELF_RESOLVED");
  assert.equal(r.status === "SELF_RESOLVED" && r.profile.email, "me@x.com");
});

test("an email not in the registry is IDENTITY_NOT_FOUND, never a guess", () => {
  const r = resolveRequester({ servable: directory, all: directory, identity: { email: "guest@elsewhere.com" } });
  assert.equal(r.status, "IDENTITY_NOT_FOUND");
});

test("no email at all (getMember failed / guest) is IDENTITY_NOT_FOUND", () => {
  const r = resolveRequester({ servable: directory, all: directory, identity: { aadObjectId: "aad-123" } });
  assert.equal(r.status, "IDENTITY_NOT_FOUND");
});

test("display name alone never resolves an identity", () => {
  const r = resolveRequester({ servable: directory, all: directory, identity: { displayName: "ฉัน เอง" } });
  assert.equal(r.status, "IDENTITY_NOT_FOUND");
});

test("a requester present in the registry but filtered out is PROFILE_INACTIVE", () => {
  const servable = { ...directory };
  delete servable["me@x.com"];
  const r = resolveRequester({ servable, all: directory, identity: { email: "me@x.com" } });
  assert.equal(r.status, "PROFILE_INACTIVE");
});

test("a duplicated canonical email is IDENTITY_AMBIGUOUS, never a guess", () => {
  const dupe = { ...directory, "dupe-key": P("me@x.com", { fullNameTh: "อีกคน ชื่อซ้ำ" }) };
  const r = resolveRequester({ servable: dupe, all: dupe, identity: { email: "me@x.com" } });
  assert.equal(r.status, "IDENTITY_AMBIGUOUS");
});

test("identityKey is pseudonymous and stable (no PII for telemetry)", () => {
  const k = identityKey("me@x.com");
  assert.equal(k, identityKey("ME@X.COM"), "must be case-insensitive/stable");
  assert.doesNotMatch(k, /me@x\.com/i, "must not contain the email");
  assert.ok(k.length >= 8);
});

// ── SELF retrieval ──────────────────────────────────────────────────────

const self = (subIntent: IntentResult["subIntent"]): IntentResult => ({
  subIntent,
  searchParams: {},
  confidence: 0.9,
  targetType: "SELF",
});

test("REPORTING_LINE + SELF answers from the requester's own profile (the P0)", () => {
  const r = retrieve({ intent: self("REPORTING_LINE"), directory, requester: ME, now: NOW });
  assert.equal(r.totalMatches, 1);
  assert.equal(r.results[0]?.profile.email, "boss@x.com");
  assert.equal(r.results[0]?.reasonCode, "supervisor");
});

test("REPORTING_LINE + SELF bypasses name search entirely (no personRef needed)", () => {
  // The old code required a typed name here and returned 0. Nothing is typed now.
  const r = retrieve({ intent: self("REPORTING_LINE"), directory, requester: ME, now: NOW });
  assert.notEqual(r.totalMatches, 0, "self reporting-line must not depend on a typed name");
});

test("PERSON_LOOKUP + SELF returns only the requester, never a namesake", () => {
  const r = retrieve({ intent: self("PERSON_LOOKUP"), directory, requester: ME, now: NOW });
  assert.deepEqual(r.results.map((x) => x.profile.email), ["me@x.com"]);
});

test("TENURE + SELF computes from startDate, not a snapshot column", () => {
  const r = retrieve({ intent: self("TENURE"), directory, requester: ME, now: NOW });
  assert.equal(r.totalMatches, 1);
  assert.equal(r.results[0]?.profile.tenureYears, 6); // 2020-01-15 → 2026-07-15
  assert.equal(r.results[0]?.profile.tenureMonths, 6);
});

test("SELF with no resolved requester fails safely — never falls back to a name search", () => {
  const r = retrieve({ intent: self("REPORTING_LINE"), directory, now: NOW });
  assert.equal(r.totalMatches, 0);
  assert.equal(r.suggestCorrection, false, "an unresolved identity is not a data-correction problem");
});

test("a top-level employee with no supervisor fails explainably, not by guessing", () => {
  const r = retrieve({ intent: self("REPORTING_LINE"), directory, requester: TOP, now: NOW });
  assert.equal(r.totalMatches, 0);
  assert.equal(r.noSupervisor, true);
});

// ── Privacy: no cross-user leakage ──────────────────────────────────────

test("two requesters get their own answers, never each other's", () => {
  const mine = retrieve({ intent: self("PERSON_LOOKUP"), directory, requester: ME, now: NOW });
  const theirs = retrieve({ intent: self("PERSON_LOOKUP"), directory, requester: OTHER, now: NOW });
  assert.deepEqual(mine.results.map((x) => x.profile.email), ["me@x.com"]);
  assert.deepEqual(theirs.results.map((x) => x.profile.email), ["other@x.com"]);
});

// ── End-to-end through the connector ────────────────────────────────────

const deps = (over = {}) => ({
  intentLlm: async () => JSON.stringify({ subIntent: "REPORTING_LINE", searchParams: {}, confidence: 0.9 }),
  responderLlm: async () => "หัวหน้าของคุณคือ หัวหน้า ใหญ่ ครับ",
  getDirectory: async () => directory,
  getKnownNames: async () => [],
  now: NOW,
  ...over,
});

test('connector: "หัวหน้าฉันคือใคร" with identity resolves (was rc=0 in production)', async () => {
  const res = await handlePeopleQuery("หัวหน้าฉันคือใคร", deps(), { requester: { email: "me@x.com" } });
  assert.equal(res.resultCount, 1);
  assert.equal(res.identityOutcome, "SELF_RESOLVED");
  assert.match(res.text, /หัวหน้า ใหญ่/);
});

test("connector: self question without identity explains instead of saying 'not found'", async () => {
  const res = await handlePeopleQuery("หัวหน้าฉันคือใคร", deps(), {});
  assert.equal(res.resultCount, 0);
  assert.equal(res.identityOutcome, "IDENTITY_NOT_FOUND");
  assert.doesNotMatch(res.text, /ไม่พบคนที่ตรงกับที่ถามมา/, "should explain the identity gap, not a search miss");
});

test("connector: self-resolution can be disabled without disabling People Connector", async () => {
  const res = await handlePeopleQuery("หัวหน้าฉันคือใคร", deps({ selfEnabled: false }), {
    requester: { email: "me@x.com" },
  });
  assert.equal(res.identityOutcome, undefined);
  // Still serves other-person questions.
  const other = await handlePeopleQuery("หัวหน้าของคนอื่น เขา คือใคร", deps({
    selfEnabled: false,
    intentLlm: async () => JSON.stringify({ subIntent: "REPORTING_LINE", searchParams: { personRef: "คนอื่น เขา" }, confidence: 0.9 }),
  }), {});
  assert.equal(other.resultCount, 1);
});
