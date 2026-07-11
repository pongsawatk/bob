// Characterization tests (WP-01) — pin the Tier-0 pre-cache short-circuit that
// runs before the router. Protects the pipeline entry (precache → router → domainBot)
// invariant the spec forbids changing without a migration plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPrecache } from "../src/pipeline/precache.ts";
import { remainingHolidaysBlock } from "../src/kb/holidays.ts";

test("greeting → GENERAL precache hit", () => {
  const hit = checkPrecache("สวัสดีครับ");
  assert.ok(hit);
  assert.equal(hit.category, "GENERAL");
  assert.match(hit.answer, /ผม BOB/);
});

test("thanks → GENERAL precache hit", () => {
  const hit = checkPrecache("ขอบคุณครับ");
  assert.ok(hit);
  assert.equal(hit.category, "GENERAL");
});

test("remaining-holidays question → HR precache when the year's dataset exists", () => {
  const block = remainingHolidaysBlock();
  const hit = checkPrecache("วันหยุดเหลือกี่วัน");
  if (block) {
    assert.ok(hit);
    assert.equal(hit.category, "HR");
    assert.match(hit.answer, /วันหยุด/);
  } else {
    assert.equal(hit, null); // no dataset for this year → defer to the LLM
  }
});

test("month-scoped holiday question bypasses precache (needs LLM nuance)", () => {
  assert.equal(checkPrecache("วันหยุดที่เหลือเดือนนี้มีกี่วัน"), null);
});

test("personal leave quota bypasses precache (→ HumanSoft/LLM, not holidays)", () => {
  assert.equal(checkPrecache("วันหยุดกับวันลาพักร้อนเหลือกี่วัน"), null);
});

test("non-holiday chatter → no precache", () => {
  assert.equal(checkPrecache("อยากกินข้าวเที่ยง"), null);
});

test("overlong message → no precache", () => {
  assert.equal(checkPrecache("วันหยุดเหลือกี่วัน " + "ก".repeat(60)), null);
});
