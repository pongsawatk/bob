// WP-11/12 — schema v1.0 validation + 6-section renderer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAnalysis,
  sampleEvidence,
  renderReport,
  type AnalysisOutput,
  type ValidateContext,
} from "../src/analytics/report.ts";
import type { MetricReport } from "../src/analytics/langfuse.ts";

const mr = (o: Partial<MetricReport> = {}): MetricReport => ({
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z", days: 7 },
  completeness: 1, turns: 100, uniqueUsers: 40, sessions: 60, repeatUsers: 12,
  repeatUserRate: 0.3, oneShotRate: 0.59, intents: { HR: 50, GENERAL: 30, UNKNOWN: 5 },
  unknownTurns: 5, truncatedTurns: 3, fromCacheTurns: 20, latencyP50Ms: 3000, latencyP95Ms: 9000, costUsd: 0.5, ...o,
});

const ctx: ValidateContext = { evidenceIds: new Set(["M1", "E1", "D1"]), allowedOwners: ["HR", "Platform Team"] };

const good: AnalysisOutput = {
  schemaVersion: "1.0",
  executiveSummary: [{ statement: "ผู้ใช้เพิ่มขึ้น", evidenceIds: ["M1"] }],
  topTopics: [{ intent: "HR", topic: "การลา", evidenceIds: ["M1"] }],
  gaps: [{ id: "G1", category: "knowledge", statement: "ลาพักร้อนคงเหลือตอบไม่ได้", severity: "high", evidenceIds: ["E1"] }],
  recommendations: [{
    id: "R1", priority: "P0", type: "kb", statement: "เพิ่ม KB ลาพักร้อน", evidenceIds: ["E1"],
    impact: "high", effort: "medium", confidence: "high", owner: "HR", dueDate: null, status: "proposed",
  }],
  limitations: [{ statement: "completeness ต่ำ", evidenceIds: ["D1"] }],
};
const samples = [{ id: "E1", intent: "UNKNOWN", text: "ลาพักร้อนเหลือกี่วัน" }];

test("validateAnalysis: accepts a well-formed v1.0 object", () => {
  assert.equal(validateAnalysis(good, ctx).ok, true);
});

test("validateAnalysis: rejects evidence ids not in the catalog", () => {
  const bad = { ...good, gaps: [{ ...good.gaps[0]!, evidenceIds: ["M9"] }] };
  const r = validateAnalysis(bad, ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('unknown evidence "M9"')));
});

test("validateAnalysis: rejects owner outside allowedOwners", () => {
  const bad = { ...good, recommendations: [{ ...good.recommendations[0]!, owner: "Finance" }] };
  const r = validateAnalysis(bad, ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("owner must be null or in allowedOwners")));
});

test("validateAnalysis: rejects bad priority, status, and >8 recommendations", () => {
  assert.equal(validateAnalysis({ ...good, recommendations: [{ ...good.recommendations[0]!, priority: "P9" }] }, ctx).ok, false);
  assert.equal(validateAnalysis({ ...good, recommendations: [{ ...good.recommendations[0]!, status: "done" }] }, ctx).ok, false);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...good.recommendations[0]!, id: `R${i}` }));
  const r = validateAnalysis({ ...good, recommendations: many }, ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("exceed 8")));
});

test("validateAnalysis: owner null is allowed", () => {
  assert.equal(validateAnalysis({ ...good, recommendations: [{ ...good.recommendations[0]!, owner: null }] }, ctx).ok, true);
});

test("sampleEvidence: redacts input and assigns E-ids", () => {
  const ev = sampleEvidence([{ id: "t1", input: "ส่งเมล a@b.com", metadata: { category: "HR" } }], ["t1"]);
  assert.equal(ev[0]!.id, "E1");
  assert.match(ev[0]!.text, /\[email\]/);
});

test("renderReport: full report — 6 sections, priority-sorted recs, evidence refs", () => {
  const p1 = { ...good.recommendations[0]!, id: "R2", priority: "P2" as const, statement: "งาน P2" };
  const out = renderReport({ current: mr(), previous: mr({ turns: 80 }), analysis: { ...good, recommendations: [p1, good.recommendations[0]!] }, samples });
  for (const h of ["## 1. Executive Summary", "## 2. ", "## 3. ", "## 4. Gap Analysis", "## 5. ", "## 6. Appendix"])
    assert.ok(out.includes(h), `missing ${h}`);
  assert.match(out, /turns \| 100 \| 80/);
  assert.match(out, /เพิ่ม KB ลาพักร้อน/);
  assert.match(out, /_\(M1\)_/); // evidence ref rendered
  // P0 must render before P2
  assert.ok(out.indexOf("P0 [kb]") < out.indexOf("P2 [kb]"));
  assert.match(out, /ข้อจำกัด/); // limitations rendered
});

test("renderReport: null analysis → numbers-only notice, appendix still renders", () => {
  const out = renderReport({ current: mr(), previous: mr(), analysis: null, samples });
  assert.match(out, /AI analysis unavailable/);
  assert.match(out, /turns \| 100/);
  assert.match(out, /`E1`/);
  assert.doesNotMatch(out, /เพิ่ม KB ลาพักร้อน/);
});

test("renderReport: partial data warns + suppresses recommendations", () => {
  const out = renderReport({ current: mr({ completeness: 0.5 }), previous: mr(), analysis: good, samples });
  assert.match(out, /PARTIAL DATA/);
  assert.doesNotMatch(out, /เพิ่ม KB ลาพักร้อน/);
});
