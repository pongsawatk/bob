// WP-20.2 — profileStore: deterministic cross-person lookups over the directory.
// Pure functions taking a fixture map; no Graph/Redis. These pin the retrieval
// primitives the People Connector pipeline (WP-21.3) builds on.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { findByNickname, findByName, findSupervisor, listTeamMembers, tenure, norm } = await import(
  "../src/people/profileStore.ts"
);
import type { Profile } from "../src/people/directory.ts";

const P = (email: string, over: Partial<Profile> = {}): Profile => ({
  email,
  fullNameTh: over.fullNameTh ?? "ชื่อ นามสกุล",
  ...over,
  email: email.toLowerCase(),
});

// A small fixture directory keyed by email (as directory.ts stores it).
const map: Record<string, Profile> = {
  "boss@builk.com": P("boss@builk.com", { fullNameTh: "สมชาย ใจดี", fullNameEn: "Somchai Jaidee", nickname: "ชาย", org: "BOG", department: "Engineering", team: "Platform" }),
  "alice@builk.com": P("alice@builk.com", { fullNameTh: "อลิส ทดสอบ", fullNameEn: "Alice Test", nickname: "อลิซ", org: "BOG", department: "Engineering", team: "Platform", supervisor: "boss@builk.com", startDate: "2005-05-17" }),
  "bob@builk.com": P("bob@builk.com", { fullNameTh: "บ๊อบ มานะ", nickname: "บ๊อบ", org: "BOG", department: "Engineering", team: "Data", supervisor: "สมชาย ใจดี" }),
  "carol@builk.com": P("carol@builk.com", { fullNameTh: "แครอล สุข", nickname: "อลิซ", org: "BOG", department: "Sales", team: "Field", supervisor: "ไม่มี ตัวตน" }),
  "dave@builk.com": P("dave@builk.com", { fullNameTh: "เดฟ เดี่ยว", supervisor: "dave@builk.com" }), // self-reference
};

test("norm: NFC + lowercase + collapse whitespace", () => {
  assert.equal(norm("  Alice   Test "), "alice test");
  assert.equal(norm(undefined), "");
});

test("findByNickname: exact-normalized, returns all sharing a nickname", () => {
  const r = findByNickname(map, " อลิซ ");
  assert.deepEqual(r.map((p) => p.email).sort(), ["alice@builk.com", "carol@builk.com"]);
  assert.equal(findByNickname(map, "").length, 0);
  assert.equal(findByNickname(map, "ไม่มีชื่อนี้").length, 0);
});

test("findByName: substring across TH/EN/nickname, min 2 chars", () => {
  assert.deepEqual(findByName(map, "somchai").map((p) => p.email), ["boss@builk.com"]);
  assert.deepEqual(findByName(map, "ทดสอบ").map((p) => p.email), ["alice@builk.com"]);
  assert.equal(findByName(map, "a").length, 0); // too short
});

test("findSupervisor: resolves by email", () => {
  const r = findSupervisor(map, "alice@builk.com");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.supervisor.email, "boss@builk.com");
});

test("findSupervisor: resolves by exact name", () => {
  const r = findSupervisor(map, "bob@builk.com");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.supervisor.email, "boss@builk.com");
});

test("findSupervisor: unresolved when name matches nobody", () => {
  assert.equal(findSupervisor(map, "carol@builk.com").status, "unresolved");
});

test("findSupervisor: self-reference is unresolved, not a cycle", () => {
  assert.equal(findSupervisor(map, "dave@builk.com").status, "unresolved");
});

test("findSupervisor: none when no supervisor field", () => {
  assert.equal(findSupervisor(map, "boss@builk.com").status, "none");
});

test("listTeamMembers: matches all provided fields, name-sorted, capped; empty filter → []", () => {
  const eng = listTeamMembers(map, { department: "Engineering" });
  assert.deepEqual(eng.map((p) => p.email).sort(), ["alice@builk.com", "bob@builk.com", "boss@builk.com"]);
  const platform = listTeamMembers(map, { department: "Engineering", team: "Platform" });
  assert.deepEqual(platform.map((p) => p.email).sort(), ["alice@builk.com", "boss@builk.com"]);
  assert.equal(listTeamMembers(map, {}).length, 0);
  assert.equal(listTeamMembers(map, { team: "  " }).length, 0);
  assert.equal(listTeamMembers(map, { department: "Engineering" }, 1).length, 1); // cap
});

test("tenure: whole years/months in Asia/Bangkok, not rounded up", () => {
  assert.deepEqual(tenure("2005-05-17", new Date("2026-07-12T00:00:00Z")), { years: 21, months: 1 });
  // day-of-month not yet reached → month not counted
  assert.deepEqual(tenure("2020-01-20", new Date("2021-01-10T00:00:00Z")), { years: 0, months: 11 });
});

test("tenure: leap-year start and malformed/future dates", () => {
  assert.deepEqual(tenure("2020-02-29", new Date("2021-03-01T00:00:00Z")), { years: 1, months: 0 });
  assert.equal(tenure(undefined, new Date()), null);
  assert.equal(tenure("17/05/2548", new Date()), null); // not ISO
  assert.deepEqual(tenure("2030-01-01", new Date("2026-07-12T00:00:00Z")), { years: 0, months: 0 }); // future → clamp
});
