// Wave-1 wiring — /people parser + orchestrator (handlePeopleQuery) with mock
// LLMs and a fixture directory. Proves routing: REFUSE/clarify/tag-coming-soon/
// directory answer, plus audit records outcomes and the responder post-check
// still guards the wired path.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { handlePeopleQuery } = await import("../src/people/connector.ts");
const { parsePeopleCommand } = await import("../src/channels/people.ts");
const { createAuditLog } = await import("../src/people/audit/log.ts");
import type { Profile } from "../src/people/directory.ts";
import type { PeopleDeps } from "../src/people/connector.ts";
import type { TagMap } from "../src/people/retrieval/search.ts";

const P = (email: string, o: Partial<Profile> & { fullNameTh: string }): Profile => ({ ...o, email: email.toLowerCase() });
const directory: Record<string, Profile> = {
  "somchai@builk.com": P("somchai@builk.com", { fullNameTh: "สมชาย ใจดี", nickname: "ชาย", department: "Engineering" }),
  "alice@builk.com": P("alice@builk.com", { fullNameTh: "อลิส ทดสอบ", nickname: "โบ๊ท", department: "Engineering", supervisor: "somchai@builk.com" }),
};
const knownNames = ["สมชาย ใจดี", "ชาย", "อลิส ทดสอบ", "โบ๊ท", "อินทรา"]; // อินทรา = intruder not in dir

const deps = (intentJson: string, responderText = "ตอบตาม FACTS ครับ", tags: TagMap = {}): PeopleDeps => ({
  intentLlm: async () => intentJson,
  responderLlm: async () => responderText,
  getDirectory: async () => directory,
  getKnownNames: async () => knownNames,
  tags,
  audit: createAuditLog(),
  now: new Date("2026-07-12T00:00:00Z"),
});

const intent = (subIntent: string, sp: object, confidence = 0.9) => JSON.stringify({ subIntent, searchParams: sp, confidence });

test("parsePeopleCommand: prefix / usage / query extraction", () => {
  assert.equal(parsePeopleCommand("hello"), null);
  assert.deepEqual(parsePeopleCommand("/people"), { kind: "usage" });
  assert.deepEqual(parsePeopleCommand("  /People  ทีม Jubili มีใครบ้าง "), { kind: "query", query: "ทีม Jubili มีใครบ้าง" });
});

test("PERSON_LOOKUP → ALLOW → composed answer; audit logs ALLOW", async () => {
  const d = deps(intent("PERSON_LOOKUP", { personRef: "โบ๊ท" }));
  const r = await handlePeopleQuery("พี่โบ๊ทอยู่ทีมไหน", d);
  assert.equal(r.outcome, "ALLOW");
  assert.equal(r.resultCount, 1);
  assert.equal(r.text, "ตอบตาม FACTS ครับ");
  assert.equal(d.audit!.all()[0]?.policyOutcome, "ALLOW");
});

test("blocked query → REFUSE message (uses original query text, not intent)", async () => {
  const d = deps(intent("PERSON_LOOKUP", { personRef: "สมชาย" }));
  const r = await handlePeopleQuery("เงินเดือนของสมชายเท่าไหร่", d);
  assert.equal(r.outcome, "REFUSE");
  assert.match(r.text, /ช่วยไม่ได้/);
  assert.equal(d.audit!.all()[0]?.policyOutcome, "REFUSE");
});

test("low confidence → clarify", async () => {
  const r = await handlePeopleQuery("อืม", deps(intent("PERSON_LOOKUP", {}, 0.3)));
  assert.equal(r.outcome, "UNABLE_TO_DETERMINE");
  assert.match(r.text, /ระบุให้ชัด/);
});

test("tag intent with no tags → coming-soon (G0 not yet)", async () => {
  const r = await handlePeopleQuery("ใครดูแล Pojjaman", deps(intent("OWNER_LOOKUP", { topic: "Pojjaman" })));
  assert.equal(r.outcome, "ALLOW");
  assert.match(r.text, /กำลังจะเปิด/);
});

test("tag intent WITH tags → owner served", async () => {
  const tags: TagMap = { "somchai@builk.com": { ownershipTags: ["Pojjaman"] } };
  const r = await handlePeopleQuery("ใครดูแล Pojjaman", deps(intent("OWNER_LOOKUP", { topic: "Pojjaman" }), "คุณสมชายดูแลครับ", tags));
  assert.equal(r.resultCount, 1);
  assert.equal(r.text, "คุณสมชายดูแลครับ");
});

test("directory intent no match → not-found template", async () => {
  const r = await handlePeopleQuery("หาคนชื่อ xyz", deps(intent("PERSON_LOOKUP", { personRef: "ไม่มีใครแน่ ๆ" })));
  assert.equal(r.resultCount, 0);
  assert.match(r.text, /ยังไม่พบ/);
});

test("responder post-check still guards the wired path (intruder name → fallback)", async () => {
  const d = deps(intent("PERSON_LOOKUP", { personRef: "โบ๊ท" }), "จริง ๆ คุณอินทรา ก็ช่วยได้ครับ");
  const r = await handlePeopleQuery("พี่โบ๊ท", d);
  assert.equal(r.usedFallback, true);
  assert.match(r.text, /อลิส ทดสอบ/); // fell back to the facts template, not the LLM text
});
