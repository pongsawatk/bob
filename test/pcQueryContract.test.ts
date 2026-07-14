// WP-02 — deterministic query contract & multi-filter retrieval.
// Characterization of the P0-2 bug: a role constraint alongside a team was
// dropped entirely (SearchParams had no `role`), so "ทีม DX มี QA กี่คน" broad-matched
// the team and returned the whole roster. Retrieval must AND every supplied filter,
// report exact totals, and expose the candidate set the responder is allowed to name.
//
// Synthetic fixture only — production roster numbers are never hard-coded here.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { retrieve } = await import("../src/people/retrieval/search.ts");
const { canonicalRole, roleMatchesPosition } = await import("../src/people/retrieval/roles.ts");
import type { Profile } from "../src/people/directory.ts";
import type { IntentResult } from "../src/people/pcTypes.ts";

const P = (email: string, fullNameTh: string, position: string, subOrg: string): Profile => ({
  email: email.toLowerCase(),
  fullNameTh,
  position,
  subOrg,
});

// DX: 3 QA + 1 Project Coordinator + 2 Developers = 6. Ops: 1 QA (must never leak into DX).
const directory: Record<string, Profile> = {
  "q1@x.com": P("q1@x.com", "กอ หนึ่ง", "QA Engineer", "DX"),
  "q2@x.com": P("q2@x.com", "ขอ สอง", "Software Tester", "DX"),
  "q3@x.com": P("q3@x.com", "คอ สาม", "ผู้ทดสอบระบบ", "DX"),
  "pc1@x.com": P("pc1@x.com", "งอ สี่", "Project Coordinator", "DX"),
  "d1@x.com": P("d1@x.com", "จอ ห้า", "Senior Developer", "DX"),
  "d2@x.com": P("d2@x.com", "ฉอ หก", "Software Engineer", "DX"),
  "ops1@x.com": P("ops1@x.com", "ชอ เจ็ด", "QA Engineer", "Operations"),
};

const q = (searchParams: IntentResult["searchParams"], over: Partial<IntentResult> = {}): IntentResult => ({
  subIntent: "TEAM_ROSTER",
  searchParams,
  confidence: 0.9,
  ...over,
});

const emailsOf = (r: { results: { profile: { email?: string } }[] }) =>
  r.results.map((x) => x.profile.email).sort();

// ── AND semantics ────────────────────────────────────────────────────────

test("team + role ANDs both filters (DX + QA → only DX's QAs, not the whole roster)", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "QA" }), directory });
  assert.deepEqual(emailsOf(r), ["q1@x.com", "q2@x.com", "q3@x.com"]);
  assert.equal(r.totalMatches, 3);
});

test("team + role never leaks a same-role member of another team", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "QA" }), directory });
  assert.ok(!emailsOf(r).includes("ops1@x.com"), "Operations QA must not appear under team=DX");
});

test("team + Project Coordinator narrows to the single match", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "Project Coordinator" }), directory });
  assert.deepEqual(emailsOf(r), ["pc1@x.com"]);
  assert.equal(r.totalMatches, 1);
});

test("an unknown role still filters (never silently dropped → never broad-matches the team)", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "Scrum Master" }), directory });
  assert.equal(r.totalMatches, 0);
  assert.equal(r.fallback, true);
});

// ── countOnly ────────────────────────────────────────────────────────────

test("countOnly returns the exact deterministic total and sends no roster to the LLM", () => {
  const r = retrieve({ intent: q({ team: "DX" }, { countOnly: true }), directory });
  assert.equal(r.totalMatches, 6);
  assert.equal(r.results.length, 0, "countOnly must not ship candidate rows");
  assert.equal(r.countOnly, true);
});

test("countOnly counts the filtered set, not the team", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "QA" }, { countOnly: true }), directory });
  assert.equal(r.totalMatches, 3);
});

// ── Truncation contract ──────────────────────────────────────────────────

test("truncated roster reports totalMatches vs shownCount honestly", () => {
  const r = retrieve({ intent: q({ team: "DX" }), directory, limit: 2 });
  assert.equal(r.totalMatches, 6);
  assert.equal(r.shownCount, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.results.length, 2);
});

test("a complete roster is not marked truncated", () => {
  const r = retrieve({ intent: q({ team: "DX" }), directory });
  assert.equal(r.totalMatches, 6);
  assert.equal(r.shownCount, 6);
  assert.equal(r.truncated, false);
});

// ── Structured result surface ────────────────────────────────────────────

test("filtersApplied reports the canonical filters actually used", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "tester" }), directory });
  assert.deepEqual(r.filtersApplied, { team: "DX", role: "QUALITY_ASSURANCE" });
});

test("candidateIds carries every shown candidate (the responder's name allowlist)", () => {
  const r = retrieve({ intent: q({ team: "DX", role: "QA" }), directory });
  assert.deepEqual([...r.candidateIds].sort(), ["q1@x.com", "q2@x.com", "q3@x.com"]);
});

// ── Role taxonomy ────────────────────────────────────────────────────────

test("canonicalRole maps QA / Quality Assurance / tester / ผู้ทดสอบ to one concept", () => {
  for (const raw of ["QA", "qa", "Quality Assurance", "tester", "Tester", "ผู้ทดสอบ"]) {
    assert.equal(canonicalRole(raw), "QUALITY_ASSURANCE", `${raw} should canonicalize to QUALITY_ASSURANCE`);
  }
});

test("canonicalRole maps Project Coordinator variants", () => {
  assert.equal(canonicalRole("Project Coordinator"), "PROJECT_COORDINATOR");
  assert.equal(canonicalRole("ผู้ประสานงานโครงการ"), "PROJECT_COORDINATOR");
});

test("canonicalRole returns null for a role it does not know", () => {
  assert.equal(canonicalRole("Scrum Master"), null);
});

test("roleMatchesPosition does not confuse QA Engineer with a Developer", () => {
  assert.equal(roleMatchesPosition("QA Engineer", "QUALITY_ASSURANCE"), true);
  assert.equal(roleMatchesPosition("Software Engineer", "QUALITY_ASSURANCE"), false);
  assert.equal(roleMatchesPosition("Senior Developer", "DEVELOPER"), true);
  assert.equal(roleMatchesPosition("QA Engineer", "DEVELOPER"), false);
});
