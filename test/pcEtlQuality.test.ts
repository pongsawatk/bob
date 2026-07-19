// WP-04 — directory ETL & data quality.
// The parser already split the "พนักงานลาออก" section correctly (verified in WP-00), so
// this covers what was missing: the active map is keyed by email, which means a
// duplicated address in the sheet silently collapses two people into whichever row was
// written last — and self-identity answers would then go to the wrong person. Plus the
// invisible-character normalization and the freshness stamps the answers need.
//
// Synthetic fixtures only — no real registry rows.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { parseRows, DIRECTORY_SCHEMA_VERSION } = await import("../src/people/directory.ts");

const HEADER = ["Email", "ชื่อ", "นามสกุล", "ชื่อเล่น", "ตำแหน่ง", "Org", "Sub Org", "Group", "Corporate Department", "Function", "วันที่เริ่มงาน", "Supervisor"];
const row = (email: string, first: string, last = "นามสกุล", over: Record<number, unknown> = {}) => {
  const r: unknown[] = [email, first, last, "", "", "", "", "", "", "", "", ""];
  for (const [i, v] of Object.entries(over)) r[Number(i)] = v;
  return r;
};

test("schema version is exposed so a stored snapshot can be told apart", () => {
  assert.ok(Number(DIRECTORY_SCHEMA_VERSION) >= 1);
});

// ── Duplicate emails ────────────────────────────────────────────────────

test("a duplicated email inside the active section is reported, not silently collapsed", () => {
  const p = parseRows([HEADER, row("dupe@x.com", "คนแรก"), row("dupe@x.com", "คนที่สอง")]);
  assert.deepEqual(p.duplicateEmails, ["dupe@x.com"]);
  assert.ok(p.warnings.some((w) => /dupe@x\.com/.test(w)), "the warning must name the offending address");
});

// An email in BOTH sections is a re-hire (HR keeps the old stint below the divider
// as history): the active row wins, the resigned projection drops it, and it is
// warned — not treated as ambiguity, and never a reason to refuse the refresh
// (this exact case blocked /refresh in production on 2026-07-19).
test("an email appearing in both sections is a re-hire: active wins, warned, not a duplicate", () => {
  const p = parseRows([HEADER, row("both@x.com", "ยังอยู่"), ["พนักงานลาออก"], HEADER, row("both@x.com", "ลาออกแล้ว")]);
  assert.deepEqual(Object.keys(p.active), ["both@x.com"]);
  assert.equal(p.active["both@x.com"]?.fullNameTh, "ยังอยู่ นามสกุล"); // current stint's row
  assert.deepEqual(p.resigned, []);
  assert.deepEqual(p.duplicateEmails, []);
  assert.ok(p.warnings.some((w) => /re-hired/.test(w) && /both@x\.com/.test(w)));
});

test("clean data reports no duplicates", () => {
  const p = parseRows([HEADER, row("a@x.com", "เอ"), row("b@x.com", "บี")]);
  assert.deepEqual(p.duplicateEmails, []);
});

// ── The existing active/resigned split must not regress ─────────────────

test("resigned rows never enter the active projection", () => {
  const p = parseRows([HEADER, row("active@x.com", "ยังอยู่"), ["พนักงานลาออก"], HEADER, row("gone@x.com", "ลาออก")]);
  assert.deepEqual(Object.keys(p.active), ["active@x.com"]);
  assert.deepEqual(p.resigned, ["gone@x.com"]);
});

// ── Normalization ───────────────────────────────────────────────────────

test("NBSP, tabs and repeated spaces collapse to single spaces", () => {
  const p = parseRows([HEADER, row("n@x.com", "สม ชาย", "ใจ  ดี")]);
  assert.equal(p.active["n@x.com"]?.fullNameTh, "สม ชาย ใจ ดี");
});

// Width folding is done explicitly rather than via NFKC — see the `clean` doc in
// directory.ts. NFKC splits Thai SARA AM, which silently breaks the column regexes.
test("full-width characters fold to ASCII so lookups match", () => {
  const p = parseRows([HEADER, row("w@x.com", "Ｓｏｍｃｈａｉ", "Ｄｅｅ")]);
  assert.equal(p.active["w@x.com"]?.fullNameTh, "Somchai Dee");
});

test("Thai stays composed: the ตำแหน่ง column is still found after normalization", () => {
  const p = parseRows([HEADER, row("t@x.com", "ที", "หนึ่ง", { 4: "QA Engineer" })]);
  assert.equal(p.active["t@x.com"]?.position, "QA Engineer", "NFKC here would lose the position column entirely");
});

test("emails are lowercased and stripped of surrounding whitespace", () => {
  const p = parseRows([HEADER, row("  MiXeD@X.CoM  ", "มิก")]);
  assert.ok(p.active["mixed@x.com"], "email should normalize to lowercase/trimmed");
});

// ── Supervisor reference validation ─────────────────────────────────────

test("a supervisor that resolves to nobody is warned about, never guessed", () => {
  const p = parseRows([
    HEADER,
    row("a@x.com", "เอ", "หนึ่ง", { 11: "ไม่มี ตัวตน" }),
    row("b@x.com", "บี", "สอง", { 11: "เอ หนึ่ง" }),
  ]);
  assert.equal(p.unresolvedSupervisors.length, 1);
  assert.equal(p.unresolvedSupervisors[0]?.email, "a@x.com");
});

test("a resolvable supervisor produces no warning", () => {
  const p = parseRows([HEADER, row("a@x.com", "เอ", "หนึ่ง"), row("b@x.com", "บี", "สอง", { 11: "เอ หนึ่ง" })]);
  assert.deepEqual(p.unresolvedSupervisors, []);
});

test("a blank supervisor is not an error (top of the org)", () => {
  const p = parseRows([HEADER, row("a@x.com", "เอ", "หนึ่ง")]);
  assert.deepEqual(p.unresolvedSupervisors, []);
});

// ── Structure errors ────────────────────────────────────────────────────

test("a missing header row throws rather than publishing garbage", () => {
  assert.throws(() => parseRows([["ชื่อ", "นามสกุล", "ตำแหน่ง"], ["x"]]), /header/i);
});

// Regression: only a row with NO email can be the section divider. Matching "ลาออก" in
// any cell meant one person's position or note ("เจ้าหน้าที่ดูแลการลาออก") silently moved them
// AND everyone below them into the resigned section — dropped from the directory with
// no error and no warning.
test("a data row mentioning ลาออก in its own cells is not treated as the section divider", () => {
  const p = parseRows([
    HEADER,
    row("a@x.com", "เอ", "หนึ่ง", { 4: "เจ้าหน้าที่ดูแลการลาออก" }),
    row("b@x.com", "บี", "สอง"),
  ]);
  assert.deepEqual(Object.keys(p.active).sort(), ["a@x.com", "b@x.com"]);
  assert.deepEqual(p.resigned, [], "nobody should be reclassified as resigned");
});

test("blank and malformed rows are skipped, not turned into ghost profiles", () => {
  const p = parseRows([HEADER, [], ["", "", ""], row("real@x.com", "จริง"), ["not-an-email", "ผี"]]);
  assert.deepEqual(Object.keys(p.active), ["real@x.com"]);
});

// ── WP-10.1 freshness footer ────────────────────────────────────────────
// The sheet is edited on HR's schedule, so a new joiner can legitimately be missing.
// Saying when the snapshot is from lets the reader judge that themselves.

const { handlePeopleQuery } = await import("../src/people/connector.ts");
import type { Profile as P2 } from "../src/people/directory.ts";

const dir2: Record<string, P2> = {
  "a@x.com": { email: "a@x.com", fullNameTh: "เอ หนึ่ง", subOrg: "DX", position: "Developer" },
};
const baseDeps = (over = {}) => ({
  intentLlm: async () => JSON.stringify({ subIntent: "TEAM_ROSTER", searchParams: { team: "DX" }, confidence: 0.9 }),
  responderLlm: async () => "ทีม DX มี เอ หนึ่ง ครับ",
  getDirectory: async () => dir2,
  getKnownNames: async () => [],
  ...over,
});

test("an answer cites the registry snapshot date when one is stamped", async () => {
  const res = await handlePeopleQuery("ทีม DX มีใครบ้าง", baseDeps({
    getMeta: async () => ({ sourceUpdatedAt: "2026-07-11T00:00:00Z" }),
  }));
  assert.match(res.text, /ข้อมูลทะเบียน ณ/);
});

test("no stamp → no footer, never a guessed date", async () => {
  const res = await handlePeopleQuery("ทีม DX มีใครบ้าง", baseDeps({ getMeta: async () => null }));
  assert.doesNotMatch(res.text, /ข้อมูลทะเบียน ณ/);
});

test("a failing meta lookup degrades silently rather than losing the answer", async () => {
  const res = await handlePeopleQuery("ทีม DX มีใครบ้าง", baseDeps({
    getMeta: async () => { throw new Error("redis down"); },
  }));
  assert.match(res.text, /เอ หนึ่ง/);
  assert.doesNotMatch(res.text, /ข้อมูลทะเบียน ณ/);
});
