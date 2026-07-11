// G0 tag ETL plumbing — the ownership column flows sheet → Profile → TagMap →
// retrieval with no code change; it's dark only because the column is empty.
// Confirms the pilot is a data flip, and that an absent column stays inert.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { parseRows } = await import("../src/people/directory.ts");
const { tagMapFromDirectory } = await import("../src/people/retrieval/search.ts");
const { handlePeopleQuery } = await import("../src/people/connector.ts");
import type { Profile } from "../src/people/directory.ts";
import type { PeopleDeps } from "../src/people/connector.ts";

const baseHeader = ["Email", "ชื่อ", "นามสกุล", "ชื่อเล่น", "ตำแหน่ง", "Org", "Function", "วันที่เริ่มงาน", "Supervisor"];

test("parseRows reads the Ownership column into ownershipTags (comma/newline split)", () => {
  const header = [...baseHeader, "Ownership"];
  const rows = [
    header,
    ["somchai@builk.com", "สมชาย", "ใจดี", "ชาย", "CPO", "HO", "Mgmt", "17/05/2548", "", "Pojjaman, Builk360"],
    ["alice@builk.com", "อลิส", "ทดสอบ", "โบ๊ท", "Dev", "BOG", "Eng", "", "somchai@builk.com", ""],
  ];
  const { active } = parseRows(rows);
  assert.deepEqual(active["somchai@builk.com"]?.ownershipTags, ["Pojjaman", "Builk360"]);
  assert.equal(active["alice@builk.com"]?.ownershipTags, undefined); // empty cell → undefined
});

test("no Ownership column → ownershipTags undefined (inert until HR adds it)", () => {
  const rows = [baseHeader, ["a@builk.com", "เอ", "บี", "เอ", "Dev", "BOG", "Eng", "", ""]];
  assert.equal(parseRows(rows).active["a@builk.com"]?.ownershipTags, undefined);
});

test("tagMapFromDirectory only includes profiles that carry tags", () => {
  const dir: Record<string, Profile> = {
    "somchai@builk.com": { email: "somchai@builk.com", fullNameTh: "สมชาย", ownershipTags: ["Pojjaman"] },
    "alice@builk.com": { email: "alice@builk.com", fullNameTh: "อลิส" },
  };
  const tm = tagMapFromDirectory(dir);
  assert.deepEqual(Object.keys(tm), ["somchai@builk.com"]);
  assert.deepEqual(tm["somchai@builk.com"]?.ownershipTags, ["Pojjaman"]);
});

test("connector derives tags from the directory when deps.tags is omitted", async () => {
  const directory: Record<string, Profile> = {
    "somchai@builk.com": { email: "somchai@builk.com", fullNameTh: "สมชาย ใจดี", nickname: "ชาย", ownershipTags: ["Pojjaman"] },
  };
  const deps: PeopleDeps = {
    intentLlm: async () => JSON.stringify({ subIntent: "OWNER_LOOKUP", searchParams: { topic: "Pojjaman" }, confidence: 0.9 }),
    responderLlm: async () => "คุณสมชายดูแล Pojjaman ครับ",
    getDirectory: async () => directory,
    getKnownNames: async () => ["สมชาย ใจดี", "ชาย"],
    // tags omitted on purpose → derived from ownershipTags above
    now: new Date("2026-07-12T00:00:00Z"),
  };
  const r = await handlePeopleQuery("ใครดูแล Pojjaman", deps);
  assert.equal(r.resultCount, 1);
  assert.equal(r.text, "คุณสมชายดูแล Pojjaman ครับ");
});
