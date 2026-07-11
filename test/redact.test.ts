// WP-11 — redaction suite (Metric Contract §5). The payload sent to the analysis LLM
// and report must contain NO email, phone, employee id, national id, token, URL, or
// known name. Aggregate numbers ("30 วัน") must survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, findLeaks } from "../src/analytics/redact.ts";

test("masks email and Thai phone; leaves aggregate numbers intact", () => {
  const { text, counts } = redact("ติดต่อ somchai@builk.com หรือโทร 0812345678 นะครับ");
  assert.equal(counts.email, 1);
  assert.equal(counts.phone, 1);
  assert.match(text, /\[email\]/);
  assert.match(text, /\[phone\]/);
  assert.deepEqual(findLeaks(text), []);
});

test("aggregate numbers like '30 วัน' are NOT redacted", () => {
  const { text, counts } = redact("ลาป่วยได้สูงสุด 30 วันต่อปี และ OT 1.5 เท่า");
  assert.match(text, /30 วัน/);
  assert.equal(counts.phone, 0);
  assert.equal(counts.id, 0);
});

test("masks URLs", () => {
  const { text } = redact("อ่านที่ https://outline.builk.id/doc/abc-123?x=1 ครับ");
  assert.match(text, /\[url\]/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test("masks sk- keys, Bearer tokens, and long opaque tokens", () => {
  const r1 = redact("key sk-abcdefghij1234567890ABCDwxyz");
  assert.match(r1.text, /\[token\]/);
  const r2 = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  assert.match(r2.text, /\[token\]/);
  const r3 = redact("secret AKIAIOSFODNN7EXAMPLEabcdefgh12345678ok");
  assert.match(r3.text, /\[token\]/);
});

test("masks employee id, 13-digit and dashed Thai national id", () => {
  assert.match(redact("รหัส EMP-00123 ครับ").text, /\[id\]/);
  assert.match(redact("เลขบัตร 1234567890123").text, /\[id\]/);
  assert.match(redact("บัตร 1-2345-67890-12-3").text, /\[id\]/);
});

test("masks known names (list-driven, longest-first) with no partial leak", () => {
  const names = ["บ๊อบ", "สมชาย ใจดี"];
  const { text, counts } = redact("สมชาย ใจดี คุยกับ บ๊อบ เรื่องงาน", { names });
  assert.equal(counts.name, 2);
  assert.doesNotMatch(text, /สมชาย/);
  assert.doesNotMatch(text, /บ๊อบ/);
  assert.deepEqual(findLeaks(text, names), []);
});

test("findLeaks flags un-redacted PII (defense-in-depth)", () => {
  assert.deepEqual(findLeaks("clean text 30 วัน"), []);
  assert.ok(findLeaks("mail me at a@b.com").includes("email/mention"));
  assert.ok(findLeaks("call 0891234567").includes("phone"));
  assert.ok(findLeaks("สมชาย ทำงาน", ["สมชาย"]).includes("name"));
});

test("redacts non-string input by stringifying first (no raw object leaks through)", () => {
  const { text } = redact({ q: "email me x@y.com" });
  assert.match(text, /\[email\]/);
  assert.doesNotMatch(text, /x@y\.com/);
});
