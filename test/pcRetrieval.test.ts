// WP-21.3 — retrieval + ranking. Directory sub-intents over profileStore work
// today; tag sub-intents return nothing until a TagMap is supplied (proves the
// G0 gate is data, not code). Acceptance §11: caps, nickname search, reporting
// line, no company-wide enumeration, relationship types never blended.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { retrieve, toWorkProfile } = await import("../src/people/retrieval/search.ts");
const { rankTagged } = await import("../src/people/retrieval/rank.ts");
import type { Profile } from "../src/people/directory.ts";
import type { IntentResult, SubIntent } from "../src/people/pcTypes.ts";
import type { TagMap } from "../src/people/retrieval/search.ts";
import type { TaggedSearchResult } from "../src/people/retrieval/rank.ts";

const P = (email: string, o: Partial<Profile> & { fullNameTh: string }): Profile => ({
  ...o,
  email: email.toLowerCase(),
});

const directory: Record<string, Profile> = {
  "somchai@builk.com": P("somchai@builk.com", { fullNameTh: "สมชาย ใจดี", nickname: "ชาย", org: "BOG", department: "Engineering", team: "Platform", startDate: "2005-05-17" }),
  "alice@builk.com": P("alice@builk.com", { fullNameTh: "อลิส ทดสอบ", nickname: "โบ๊ท", org: "BOG", department: "Engineering", team: "Data", supervisor: "somchai@builk.com" }),
  "bob@builk.com": P("bob@builk.com", { fullNameTh: "บ๊อบ โบ๊ทสกุล", nickname: "บ๊อบ", org: "BOG", department: "Sales", team: "Field" }),
  "k1@builk.com": P("k1@builk.com", { fullNameTh: "กอ ก", nickname: "ก้อง" }),
  "k2@builk.com": P("k2@builk.com", { fullNameTh: "ขอ ข", nickname: "ก้อง" }),
  "k3@builk.com": P("k3@builk.com", { fullNameTh: "คอ ค", nickname: "ก้อง" }),
  "k4@builk.com": P("k4@builk.com", { fullNameTh: "งอ ง", nickname: "ก้อง" }),
};

const tags: TagMap = {
  "somchai@builk.com": { ownershipTags: ["Pojjaman"], expertiseTags: ["ERP integration"] },
  "alice@builk.com": { expertiseTags: ["Power BI"] },
};

const I = (subIntent: SubIntent, searchParams: IntentResult["searchParams"] = {}, confidence = 0.95): IntentResult => ({
  subIntent,
  searchParams,
  confidence,
});

test("PERSON_LOOKUP: nickname match ranks above name match", () => {
  const r = retrieve({ intent: I("PERSON_LOOKUP", { personRef: "โบ๊ท" }), directory });
  assert.equal(r.results[0]?.kind, "directory");
  assert.equal(r.results[0]?.profile.email, "alice@builk.com");
  assert.equal(r.results[0]?.reasonCode, "nickname_match");
  assert.equal(r.results[1]?.profile.email, "bob@builk.com");
  assert.equal(r.results[1]?.reasonCode, "name_match");
});

test("PERSON_LOOKUP: caps at MAX_RESULTS_FIRST_PAGE (3) but reports true total", () => {
  const r = retrieve({ intent: I("PERSON_LOOKUP", { personRef: "ก้อง" }), directory });
  assert.equal(r.results.length, 3);
  assert.equal(r.totalMatches, 4);
  assert.equal(r.shownCount, 3);
  assert.equal(r.truncated, true);
});

test("PERSON_LOOKUP: empty ref → suggestCorrection, no results", () => {
  const r = retrieve({ intent: I("PERSON_LOOKUP", {}), directory });
  assert.deepEqual([r.results.length, r.suggestCorrection], [0, true]);
});

test("PERSON_LOOKUP: no match → fallback + suggestCorrection", () => {
  const r = retrieve({ intent: I("PERSON_LOOKUP", { personRef: "ไม่มีใครชื่อนี้" }), directory });
  assert.deepEqual([r.results.length, r.fallback, r.suggestCorrection], [0, true, true]);
});

test("TEAM_ROSTER: matches org/department/team, excludes other teams", () => {
  const r = retrieve({ intent: I("TEAM_ROSTER", { team: "Engineering" }), directory });
  assert.deepEqual(
    r.results.map((x) => x.profile.email).sort(),
    ["alice@builk.com", "somchai@builk.com"],
  );
  assert.ok(r.results.every((x) => x.reasonCode === "team_member"));
});

test("TEAM_ROSTER: no team/bu → fallback (never whole company)", () => {
  const r = retrieve({ intent: I("TEAM_ROSTER", {}), directory });
  assert.deepEqual([r.results.length, r.fallback], [0, true]);
});

test("REPORTING_LINE: resolves the person's supervisor", () => {
  const r = retrieve({ intent: I("REPORTING_LINE", { personRef: "โบ๊ท" }), directory });
  assert.equal(r.results[0]?.profile.email, "somchai@builk.com");
  assert.equal(r.results[0]?.reasonCode, "supervisor");
});

test("REPORTING_LINE: no supervisor → fallback + suggestCorrection", () => {
  const r = retrieve({ intent: I("REPORTING_LINE", { personRef: "ชาย" }), directory });
  assert.deepEqual([r.results.length, r.fallback, r.suggestCorrection], [0, true, true]);
});

test("OWNER_LOOKUP: tagged result when TagMap supplied", () => {
  const r = retrieve({ intent: I("OWNER_LOOKUP", { topic: "Pojjaman" }), directory, tags });
  assert.equal(r.results.length, 1);
  const hit = r.results[0]!;
  assert.equal(hit.kind, "tagged");
  assert.equal(hit.profile.email, "somchai@builk.com");
  assert.equal(hit.kind === "tagged" && hit.relationshipType, "OWNER");
  assert.equal(hit.kind === "tagged" && hit.matchedTag, "Pojjaman");
});

test("OWNER_LOOKUP: WITHOUT tags → fallback (G0 gate is data, not code)", () => {
  const r = retrieve({ intent: I("OWNER_LOOKUP", { topic: "Pojjaman" }), directory });
  assert.deepEqual([r.results.length, r.fallback], [0, true]);
});

test("EXPERT_FIND: matches expertiseTags exactly (normalized)", () => {
  const r = retrieve({ intent: I("EXPERT_FIND", { topic: "power bi" }), directory, tags });
  assert.equal(r.results[0]?.profile.email, "alice@builk.com");
  assert.equal(r.results[0]?.kind === "tagged" && r.results[0]?.relationshipType, "EXPERT");
});

test("TEAM_DISCOVERY / EXPERIENCE_FIND → fallback (out of MVP retrieval scope)", () => {
  assert.equal(retrieve({ intent: I("TEAM_DISCOVERY", { topic: "ประกันกลุ่ม" }), directory }).fallback, true);
  assert.equal(retrieve({ intent: I("EXPERIENCE_FIND", { topic: "LINE OA" }), directory }).fallback, true);
});

test("toWorkProfile: subOrg=department, tenure computed, no personId/payroll leak", () => {
  const wp = toWorkProfile(directory["somchai@builk.com"]!, undefined, new Date("2026-07-12T00:00:00Z"));
  assert.equal(wp.subOrg, "Engineering");
  assert.equal(wp.functionTeam, "Platform");
  assert.deepEqual([wp.tenureYears, wp.tenureMonths], [21, 1]);
  assert.ok(!("personId" in wp) && !("sourceEmployeeId" in wp));
});

test("rankTagged: owner > expert > open-to-discuss, then name", () => {
  const mk = (rel: TaggedSearchResult["relationshipType"], name: string): TaggedSearchResult => ({
    kind: "tagged",
    profile: { displayName: name },
    relationshipType: rel,
    reasonCode: "x",
    matchedTag: "t",
  });
  const ranked = rankTagged([mk("OPEN_TO_DISCUSS", "z"), mk("EXPERT", "b"), mk("OWNER", "c"), mk("EXPERT", "a")]);
  assert.deepEqual(
    ranked.map((r) => [r.relationshipType, r.profile.displayName]),
    [["OWNER", "c"], ["EXPERT", "a"], ["EXPERT", "b"], ["OPEN_TO_DISCUSS", "z"]],
  );
});
