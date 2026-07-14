// Broadened TEAM_ROSTER matching (from shadow feedback: "ทีมบัญชี"/"Account
// Finance" returned 0 despite Sub Org + position hinting the team). Now parses
// Sub Org / Group and matches query tokens as substrings across org/subOrg/group/
// department/function/position, stripping a leading team/แผนก word.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { parseRows } = await import("../src/people/directory.ts");
const { retrieve } = await import("../src/people/retrieval/search.ts");
import type { Profile } from "../src/people/directory.ts";
import type { IntentResult } from "../src/people/pcTypes.ts";

const P = (email: string, o: Partial<Profile> & { fullNameTh: string }): Profile => ({ ...o, email: email.toLowerCase() });
const directory: Record<string, Profile> = {
  "somchai@builk.com": P("somchai@builk.com", { fullNameTh: "สมชาย บัญชี", position: "เจ้าหน้าที่บัญชี", subOrg: "Account & Finance" }),
  "malee@builk.com": P("malee@builk.com", { fullNameTh: "มาลี การเงิน", position: "Accountant", subOrg: "Account & Finance" }),
  "alice@builk.com": P("alice@builk.com", { fullNameTh: "อลิส เทค", position: "Developer", subOrg: "Engineering", team: "Platform" }),
};
const roster = (team: string): IntentResult => ({ subIntent: "TEAM_ROSTER", searchParams: { team }, confidence: 0.9 });
const emails = (team: string) => retrieve({ intent: roster(team), directory }).results.map((r) => r.profile.email).sort();

// SUPERSEDED BY WP-05 (alias layer). This used to assert ["somchai"] only: token
// substring matched the Thai word บัญชี inside his *position* ("เจ้าหน้าที่บัญชี") while มาลี's
// English "Accountant" missed, so "ทีมบัญชี" returned one member of a two-person team —
// an accident of which language each cell happened to be typed in.
// Asking for the accounting team now resolves the alias to the team the registry
// actually carries and returns the whole team. Behavior widened deliberately; the
// no-false-match guarantee below is unchanged.
test('Thai "ทีมบัญชี" resolves to the accounting team and returns all of it', () => {
  assert.deepEqual(emails("ทีมบัญชี"), ["malee@builk.com", "somchai@builk.com"]);
});

test('English "Account Finance" matches Sub Org "Account & Finance" (all tokens present)', () => {
  assert.deepEqual(emails("Account Finance"), ["malee@builk.com", "somchai@builk.com"]);
});

test('single word "Engineering" matches Sub Org', () => {
  assert.deepEqual(emails("Engineering"), ["alice@builk.com"]);
});

test("no false match for an unrelated team", () => {
  assert.deepEqual(emails("Marketing"), []);
});

test("OWNER_LOOKUP infers from Org/Sub Org when no tag, flags inferred + reasonCode", () => {
  const resp = retrieve({ intent: { subIntent: "OWNER_LOOKUP", searchParams: { topic: "Account" }, confidence: 0.9 }, directory });
  assert.equal(resp.inferred, true);
  assert.deepEqual(resp.results.map((r) => r.profile.email).sort(), ["malee@builk.com", "somchai@builk.com"]);
  assert.equal(resp.results[0]?.reasonCode, "inferred_org");
});

test("parseRows reads Sub Org and Group columns", () => {
  const header = ["Email", "ชื่อ", "นามสกุล", "ชื่อเล่น", "ตำแหน่ง", "Org", "Sub Org", "Group", "Corporate Department", "Function", "วันที่เริ่มงาน", "Supervisor"];
  const rows = [
    header,
    ["a@builk.com", "เอ", "บี", "เอ", "เจ้าหน้าที่บัญชี", "HO", "Account & Finance", "Finance Group", "Accounting", "AP", "", ""],
  ];
  const p = parseRows(rows).active["a@builk.com"]!;
  assert.equal(p.subOrg, "Account & Finance");
  assert.equal(p.group, "Finance Group");
});
