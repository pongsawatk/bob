// Characterization tests (WP-01) — pin current behavior of the holiday date math.
// Relevant to the Metric Contract: proves the Asia/Bangkok timezone + inclusive
// date boundary that the analytics windowing must mirror. Fully deterministic:
// remainingHolidaysBlock(now) takes an injectable clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingHolidaysBlock } from "../src/kb/holidays.ts";

const at = (iso: string) => new Date(iso);

test("Jan 1 → all 17 holidays remain (start-of-year inclusive)", () => {
  const block = remainingHolidaysBlock(at("2026-01-01T00:00:00+07:00"));
  assert.match(block, /ทั้งหมด 17 วัน/);
  assert.match(block, /วันขึ้นปีใหม่/);
});

test("Aug 1 → 5 holidays remain (mid-year subset)", () => {
  const block = remainingHolidaysBlock(at("2026-08-01T00:00:00+07:00"));
  assert.match(block, /ทั้งหมด 5 วัน/);
});

test("Dec 31 → 1 remaining (last day is inclusive, date >= today)", () => {
  const block = remainingHolidaysBlock(at("2026-12-31T12:00:00+07:00"));
  assert.match(block, /ทั้งหมด 1 วัน/);
});

test("unknown year → empty string (KB table fallback, no assertion)", () => {
  assert.equal(remainingHolidaysBlock(at("2027-06-01T00:00:00+07:00")), "");
});

test("Asia/Bangkok rolls over before UTC: 2026-12-31T18:00Z is 2027 in Bangkok → empty", () => {
  // 18:00Z = next-day 01:00 in Bangkok. A UTC-based implementation would wrongly
  // still see 2026-12-31 and report "1 วัน"; the Bangkok clock is already in 2027.
  assert.equal(remainingHolidaysBlock(at("2026-12-31T18:00:00Z")), "");
});
