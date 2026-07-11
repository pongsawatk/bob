// WP-11 — schema validation, evidence mapping, and 6-section renderer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAnalysis,
  crossCheckEvidence,
  sampleEvidence,
  renderReport,
  type AnalysisOutput,
} from "../src/analytics/report.ts";
import type { MetricReport, RawTrace } from "../src/analytics/langfuse.ts";

const mr = (o: Partial<MetricReport> = {}): MetricReport => ({
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z", days: 7 },
  completeness: 1, turns: 100, uniqueUsers: 40, sessions: 60, repeatUsers: 12,
  repeatUserRate: 0.3, oneShotRate: 0.59,
  intents: { HR: 50, PRODUCT: 30, GENERAL: 15, UNKNOWN: 5 },
  unknownTurns: 5, truncatedTurns: 3, fromCacheTurns: 20,
  latencyP50Ms: 3000, latencyP95Ms: 9000, costUsd: 0.5, ...o,
});

const validAnalysis: AnalysisOutput = {
  executiveSummary: ["ใช้งานเพิ่มขึ้น", "UNKNOWN ลดลง"],
  topTopics: [{ intent: "HR", examples: ["ลาป่วย", "โบนัส"] }],
  gaps: ["ลาพักร้อนคงเหลือยังตอบไม่ได้"],
  recommendations: [{
    id: "R1", type: "kb", statement: "เพิ่ม KB ลาพักร้อนคงเหลือ",
    evidenceIds: ["E1"], impact: "high", effort: "medium", confidence: "high",
    owner: "HR", status: "proposed",
  }],
};
const samples = [{ id: "E1", intent: "HR", text: "ลาพักร้อนเหลือกี่วัน" }];

test("validateAnalysis: accepts a well-formed object", () => {
  const r = validateAnalysis(validAnalysis);
  assert.equal(r.ok, true);
});

test("validateAnalysis: collects errors for bad shape", () => {
  const r = validateAnalysis({
    executiveSummary: ["a", "b", "c", "d", "e", "f"], // 6 > 5
    topTopics: [], gaps: [],
    recommendations: [{ id: "R", type: "bad", statement: "x", evidenceIds: [], impact: "high", effort: "low", confidence: "low", status: "open" }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.includes("1–5 bullets")));
    assert.ok(r.errors.some((e) => e.includes("type must be kb|feature|prompt")));
  }
});

test("validateAnalysis: empty object → multiple errors", () => {
  const r = validateAnalysis({});
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes("executiveSummary")));
});

test("crossCheckEvidence: flags evidence ids missing from samples", () => {
  const a: AnalysisOutput = { ...validAnalysis, recommendations: [{ ...validAnalysis.recommendations[0]!, evidenceIds: ["E1", "E9"] }] };
  assert.deepEqual(crossCheckEvidence(a, samples), ["E9"]);
  assert.deepEqual(crossCheckEvidence(validAnalysis, samples), []);
});

test("sampleEvidence: redacts input and assigns E-ids", () => {
  const raws: RawTrace[] = [
    { id: "t1", timestamp: "2026-07-01T00:00:00Z", input: "ช่วยส่งเมลไป a@b.com หน่อย", metadata: { category: "HR" } },
  ];
  const ev = sampleEvidence(raws, ["t1", "missing"]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.id, "E1");
  assert.equal(ev[0]!.intent, "HR");
  assert.match(ev[0]!.text, /\[email\]/);
  assert.doesNotMatch(ev[0]!.text, /a@b\.com/);
});

test("renderReport: full report has all 6 sections, recommendation, and sample", () => {
  const out = renderReport({ current: mr(), previous: mr({ turns: 80 }), analysis: validAnalysis, samples });
  for (const h of ["## 1. Executive Summary", "## 2. ", "## 3. ", "## 4. Gap Analysis", "## 5. ", "## 6. Appendix"])
    assert.ok(out.includes(h), `missing section: ${h}`);
  assert.match(out, /turns \| 100 \| 80/);
  assert.match(out, /เพิ่ม KB ลาพักร้อนคงเหลือ/);
  assert.match(out, /`E1`/);
  assert.doesNotMatch(out, /PARTIAL/);
});

test("renderReport: null analysis falls back to numbers-only with a notice", () => {
  const out = renderReport({ current: mr(), previous: mr(), analysis: null, samples });
  assert.match(out, /AI analysis unavailable/);
  assert.match(out, /turns \| 100/);            // numbers still render
  assert.match(out, /HR=50/);                    // intent mix fallback in §3
  assert.doesNotMatch(out, /เพิ่ม KB ลาพักร้อนคงเหลือ/); // no AI recommendations
});

test("renderReport: partial data warns and suppresses conclusions", () => {
  const out = renderReport({ current: mr({ completeness: 0.5 }), previous: mr(), analysis: validAnalysis, samples });
  assert.match(out, /PARTIAL DATA/);
  assert.match(out, /suppressed/i);
  assert.match(out, /turns \| 100/);            // numbers still render
  assert.doesNotMatch(out, /เพิ่ม KB ลาพักร้อนคงเหลือ/); // recommendation suppressed
});
