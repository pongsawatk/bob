// Characterization tests (WP-01) — pin the directory parsing + asker-only profile
// projection. These are the exact behaviors WP-20 (People Connector) will build on:
// the active/resigned split, header-offset detection, Thai Buddhist-year date
// conversion, and the privacy rule embedded in the rendered block.
//
// directory.ts imports env.ts, which throws unless OPENROUTER_API_KEY is set. Set a
// dummy BEFORE importing (env reads process.env only at import time; no network is
// touched by parseRows/renderProfileBlock).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { parseRows, renderProfileBlock, namesFromProfiles } = await import("../src/people/directory.ts");

// Header columns as they appear in "BOG ทะเบียนพนักงาน For All.xlsx".
const header = [
  "Email", "ชื่อ", "นามสกุล", "Name", "Surname", "ชื่อเล่น", "ตำแหน่ง",
  "Org", "Corporate Department", "Function", "Rank", "วันที่เริ่มงาน", "Supervisor",
];

test("parseRows: finds header below a title row, maps an active profile, converts BE date", () => {
  const rows = [
    ["ทะเบียนพนักงาน BOG"], // title row above the header — must be skipped
    header,
    ["alice@builk.com", "อลิส", "ทดสอบ", "Alice", "Test", "อลิซ", "Developer",
     "BOG", "Engineering", "Platform", "Senior", "17/05/2548", "boss@builk.com"],
  ];
  const { active, resigned } = parseRows(rows);
  assert.deepEqual(Object.keys(active), ["alice@builk.com"]);
  const p = active["alice@builk.com"]!;
  assert.equal(p.fullNameTh, "อลิส ทดสอบ");
  assert.equal(p.fullNameEn, "Alice Test");
  assert.equal(p.nickname, "อลิซ");
  assert.equal(p.position, "Developer");
  assert.equal(p.department, "Engineering");
  assert.equal(p.team, "Platform");
  assert.equal(p.startDate, "2005-05-17"); // 2548 BE − 543 = 2005
  assert.equal(p.supervisor, "boss@builk.com");
  assert.equal(p.employmentType, undefined); // column not present → undefined (G0 dependency)
  assert.equal(resigned.length, 0);
});

test("parseRows: rows below the ลาออก divider become resigned, never active", () => {
  const rows = [
    header,
    ["alice@builk.com", "อลิส", "ทดสอบ", "Alice", "Test", "อลิซ", "Dev",
     "BOG", "Eng", "Platform", "Senior", "17/05/2548", "boss@builk.com"],
    ["", "", "", "", "", "", "", "", "", "", "", "", ""], // blank row → skipped (no @)
    ["พนักงานลาออก"],                                       // divider → flips to resigned section
    header,                                                 // repeated header (no @) → skipped
    ["carol@builk.com", "แครอล", "ออก", "Carol", "Out", "", "", "", "", "", "", "", ""],
  ];
  const { active, resigned } = parseRows(rows);
  assert.deepEqual(Object.keys(active), ["alice@builk.com"]);
  assert.deepEqual(resigned, ["carol@builk.com"]);
});

test("parseRows: a re-hire (row in both sections) stays active, leaves resigned, warns", () => {
  const rows = [
    header,
    ["bird@builk.com", "นพรัตน์", "ทดสอบ", "Bird", "Test", "เบิร์ด", "CS Specialist",
     "BOG", "Cx", "Success", "Senior", "15/12/2566", "boss@builk.com"],
    ["พนักงานลาออก"],
    header,
    // Same person's OLD stint, kept below the divider as history.
    ["bird@builk.com", "นพรัตน์", "ทดสอบ", "Bird", "Test", "เบิร์ด", "Implementor",
     "BOG", "Pojjaman", "Client Solution", "Officer", "01/06/2552", ""],
    ["carol@builk.com", "แครอล", "ออก", "Carol", "Out", "", "", "", "", "", "", "", ""],
  ];
  const { active, resigned, duplicateEmails, warnings } = parseRows(rows);
  assert.deepEqual(Object.keys(active), ["bird@builk.com"]);
  assert.equal(active["bird@builk.com"]!.position, "CS Specialist"); // current stint, not the old row
  assert.deepEqual(resigned, ["carol@builk.com"]); // re-hire excluded → broadcasts reach them
  assert.deepEqual(duplicateEmails, []); // cross-section is a re-hire, not ambiguity
  assert.ok(warnings.some((w) => w.includes("re-hired") && w.includes("bird@builk.com")));
});

test("parseRows: a duplicate within the SAME section is still flagged", () => {
  const rows = [
    header,
    ["alice@builk.com", "อลิส", "หนึ่ง", "Alice", "One", "", "Dev",
     "BOG", "Eng", "Platform", "Senior", "17/05/2548", ""],
    ["alice@builk.com", "อลิส", "สอง", "Alice", "Two", "", "QA",
     "BOG", "Eng", "Quality", "Junior", "01/01/2560", ""],
  ];
  const { duplicateEmails, warnings } = parseRows(rows);
  assert.deepEqual(duplicateEmails, ["alice@builk.com"]);
  assert.ok(warnings.some((w) => w.includes("duplicate email")));
});

test("parseRows: throws when there is no Email header", () => {
  assert.throws(() => parseRows([["foo", "bar"], ["a", "b"]]), /header row/);
});

test("renderProfileBlock: asker-only projection carries nickname + the no-leak privacy rule", () => {
  const block = renderProfileBlock({
    email: "alice@builk.com", fullNameTh: "อลิส ทดสอบ", nickname: "อลิซ",
    position: "Developer", department: "Engineering", team: "Platform",
  });
  assert.match(block, /ชื่อ: อลิส ทดสอบ \(ชื่อเล่น: อลิซ\)/);
  assert.match(block, /ตำแหน่ง: Developer/);
  assert.match(block, /ห้ามเปิดเผยหรือเดาข้อมูลส่วนตัวของพนักงานคนอื่น/);
  assert.doesNotMatch(block, /เริ่มงาน/); // no startDate provided → tenure line omitted (deterministic)
});

test("namesFromProfiles: collects deduped names + nicknames for redaction (drops <2 chars)", () => {
  const names = namesFromProfiles({
    "a@x.com": { email: "a@x.com", fullNameTh: "สมชาย ใจดี", fullNameEn: "Somchai Jaidee", nickname: "บ๊อบ" },
    "b@x.com": { email: "b@x.com", fullNameTh: "สมชาย ใจดี", nickname: "ก" }, // dup name + 1-char nick
  });
  assert.ok(names.includes("สมชาย ใจดี"));
  assert.ok(names.includes("Somchai Jaidee"));
  assert.ok(names.includes("บ๊อบ"));
  assert.ok(!names.includes("ก")); // length < 2 dropped
  assert.equal(names.filter((n) => n === "สมชาย ใจดี").length, 1); // deduped
});
