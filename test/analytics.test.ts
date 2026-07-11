// WP-10 — golden tests for the deterministic analytics core (Metric Contract v0.1).
// Every expected number below is hand-computed from test-cases/analytics-fixture.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  percentile,
  bangkokDayKey,
  normalizeTrace,
  normalizeAll,
  aggregate,
  windowFor,
  type RawTrace,
} from "../src/analytics/langfuse.ts";

const fixture: RawTrace[] = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../test-cases/analytics-fixture.json", import.meta.url)), "utf8")
);

const ms = (iso: string) => Date.parse(iso);
const CURRENT = { fromMs: ms("2026-07-01T00:00:00+07:00"), toMs: ms("2026-07-08T00:00:00+07:00") };
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ── percentile (must match analyze-langfuse.mjs nearest-rank exactly) ──
test("percentile: nearest-rank, copy-sorted, empty → 0", () => {
  const xs = [8000, 1000, 2000, 3000, 4000, 5000, 2000]; // unsorted on purpose
  assert.equal(percentile(xs, 50), 3000); // floor(0.5*7)=3 → sorted[3]
  assert.equal(percentile(xs, 95), 8000); // floor(0.95*7)=6 → sorted[6]
  assert.equal(percentile([], 50), 0);
});

// ── bangkokDayKey (timezone-correct day bucketing) ─────────────────────
test("bangkokDayKey: buckets by Asia/Bangkok, not UTC", () => {
  assert.equal(bangkokDayKey(ms("2026-07-01T09:00:00+07:00")), "2026-07-01");
  assert.equal(bangkokDayKey(ms("2026-12-31T18:00:00Z")), "2027-01-01"); // 01:00 next day in Bangkok
});

// ── normalizeTrace edge cases ──────────────────────────────────────────
test("normalizeTrace: drops excluded/bot users and non-bob-chat traces", () => {
  assert.equal(normalizeTrace({ id: "x", timestamp: "2026-07-01T00:00:00Z", name: "bob-chat", userId: "eval" }), null);
  assert.equal(normalizeTrace({ id: "x", timestamp: "2026-07-01T00:00:00Z", name: "other-trace", userId: "a@b.com" }), null);
  assert.equal(normalizeTrace({ id: "x", timestamp: "2026-07-01T00:00:00Z", name: "bob-chat", userId: "" }), null);
});

test("normalizeTrace: truncation = outputTokens >= per-category cap", () => {
  const base = { id: "x", timestamp: "2026-07-01T00:00:00Z", name: "bob-chat", userId: "a@b.com" };
  assert.equal(normalizeTrace({ ...base, tags: ["teams", "HR"], metadata: { category: "HR", outputTokens: 1300 } })!.truncated, true);
  assert.equal(normalizeTrace({ ...base, tags: ["teams", "HR"], metadata: { category: "HR", outputTokens: 1299 } })!.truncated, false);
  assert.equal(normalizeTrace({ ...base, tags: ["teams", "PRODUCT"], metadata: { category: "PRODUCT", outputTokens: 1300 } })!.truncated, false);
});

test("normalizeTrace: missing category → OTHER + hasCategory false; precache tag → fromCache", () => {
  const base = { id: "x", timestamp: "2026-07-01T00:00:00Z", name: "bob-chat", userId: "a@b.com" };
  const noCat = normalizeTrace({ ...base, tags: ["teams"], metadata: { outputTokens: 0 } })!;
  assert.equal(noCat.intent, "OTHER");
  assert.equal(noCat.hasCategory, false);
  // precache tag detection is order-independent (Langfuse sorts tags alphabetically).
  const cached = normalizeTrace({ ...base, tags: ["GENERAL", "precache", "teams"], metadata: { category: "GENERAL" } })!;
  assert.equal(cached.fromCache, true);
});

test("normalizeTrace: channel from metadata.channel, not tags[0] (Langfuse sorts tags)", () => {
  const base = { id: "x", timestamp: "2026-07-01T00:00:00Z", name: "bob-chat", userId: "a@b.com" };
  // Real Langfuse ordering: tags[0] is "HR" (the category), channel is in metadata.
  const n = normalizeTrace({ ...base, tags: ["HR", "llm", "teams"], metadata: { category: "HR", channel: "teams" } })!;
  assert.equal(n.channel, "teams");
});

// ── normalizeAll: dedupe + exclusion over the fixture ──────────────────
test("normalizeAll: dedupes by id, drops eval + non-bob-chat (11 raw → 8 turns)", () => {
  const turns = normalizeAll(fixture);
  assert.equal(turns.length, 8); // t1..t6, t10, t11 (t7 eval, t8 name, t9 dup-of-t1 removed)
  assert.equal(turns.filter((t) => t.id === "t1").length, 1);
  assert.ok(!turns.some((t) => t.rawUserId === "eval"));
});

// ── aggregate: full golden report for the current window ───────────────
test("aggregate: current 7d window matches hand-computed metrics", () => {
  const r = aggregate(normalizeAll(fixture), CURRENT);
  assert.equal(r.turns, 7); // t1..t6 + t10 (t11 is 06-25, out of window)
  assert.equal(r.uniqueUsers, 4); // userA, userB, userC, userE
  assert.equal(r.sessions, 6); // S1,S2,S3,S4,S5,S7
  assert.equal(r.repeatUsers, 1); // only userA active on 2 days (07-01, 07-03)
  close(r.repeatUserRate, 0.25);
  close(r.oneShotRate, 5 / 6); // every session except S1 has one turn
  assert.deepEqual(r.intents, { HR: 3, PRODUCT: 1, GENERAL: 1, UNKNOWN: 1, OTHER: 1 });
  assert.equal(r.unknownTurns, 1);
  assert.equal(r.truncatedTurns, 2); // t2 (HR 1300), t6 (HR 1300)
  assert.equal(r.fromCacheTurns, 1); // t4 precache
  assert.equal(r.latencyP50Ms, 3000);
  assert.equal(r.latencyP95Ms, 8000);
  close(r.costUsd, 0.0195);
  close(r.completeness, 6 / 7); // t10 has no category
  assert.equal(r.window.days, 7);
});

test("aggregate: previous window isolates the out-of-window trace", () => {
  const prev = { fromMs: ms("2026-06-24T00:00:00+07:00"), toMs: ms("2026-07-01T00:00:00+07:00") };
  const r = aggregate(normalizeAll(fixture), prev);
  assert.equal(r.turns, 1); // only t11 (06-25)
  assert.equal(r.uniqueUsers, 1);
  close(r.costUsd, 0.005);
});

test("windowFor: current + equal-length previous window ending at now", () => {
  const now = ms("2026-07-08T00:00:00+07:00");
  const { current, previous } = windowFor(7, now);
  assert.equal(current.toMs, now);
  assert.equal(current.fromMs, previous.toMs); // contiguous
  assert.equal(current.toMs - current.fromMs, previous.toMs - previous.fromMs);
  assert.equal(current.fromMs, ms("2026-07-01T00:00:00+07:00"));
});
