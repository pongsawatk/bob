// WP-12 — analyze stage (schema v1.0): code-computed comparisons, evidence catalog,
// injection-wrapped input, validate/retry/fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisInput,
  buildUserMessage,
  extractJson,
  analyzeWithRetry,
  DEFAULT_ALLOWED_OWNERS,
  type LlmCall,
} from "../src/analytics/analyze.ts";
import type { MetricReport } from "../src/analytics/langfuse.ts";
import type { AnalysisOutput, EvidenceSample } from "../src/analytics/report.ts";

const mr = (o: Partial<MetricReport> = {}): MetricReport => ({
  window: { from: "2026-07-04T00:00:00.000Z", to: "2026-07-11T00:00:00.000Z", days: 7 },
  completeness: 1, turns: 100, uniqueUsers: 40, sessions: 60, repeatUsers: 12,
  repeatUserRate: 0.3, oneShotRate: 0.59, intents: { HR: 50 }, unknownTurns: 5, truncatedTurns: 3,
  fromCacheTurns: 20, latencyP50Ms: 3000, latencyP95Ms: 9000, costUsd: 0.5, ...o,
});
const cleanSamples: EvidenceSample[] = [{ id: "E1", intent: "UNKNOWN", text: "ลาพักร้อนเหลือกี่วัน" }];

function goodOutput(): AnalysisOutput {
  return {
    schemaVersion: "1.0",
    executiveSummary: [{ statement: "turns เพิ่มขึ้น", evidenceIds: ["M1"] }],
    topTopics: [{ intent: "HR", topic: "การลา", evidenceIds: ["M1"] }],
    gaps: [{ id: "G1", category: "knowledge", statement: "ตอบลาพักร้อนไม่ได้", severity: "high", evidenceIds: ["E1"] }],
    recommendations: [{ id: "R1", priority: "P0", type: "kb", statement: "เพิ่ม KB", evidenceIds: ["E1"], impact: "high", effort: "low", confidence: "high", owner: "HR", dueDate: null, status: "proposed" }],
    limitations: [],
  };
}

test("buildAnalysisInput: computes comparisons (delta/%/trend) in code", () => {
  const input = buildAnalysisInput(mr({ turns: 100 }), mr({ turns: 80 }), cleanSamples);
  const turns = input.comparisons.find((c) => c.metric === "turns")!;
  assert.equal(turns.id, "M1");
  assert.equal(turns.delta, 20);
  assert.equal(turns.percentChange, 25); // (100-80)/80 = 25%
  assert.equal(turns.trend, "up");
});

test("buildAnalysisInput: percentChange is null when previous metric is 0 (but window has data)", () => {
  const input = buildAnalysisInput(mr({ uniqueUsers: 5 }), mr({ uniqueUsers: 0 }), cleanSamples); // prev.turns=100 → available
  assert.equal(input.previousAvailable, true);
  assert.equal(input.comparisons.find((c) => c.metric === "unique users")!.percentChange, null);
});

test("buildAnalysisInput: no previous data → previousAvailable false + all comparisons null/not_available", () => {
  const input = buildAnalysisInput(mr({ turns: 203 }), mr({ turns: 0 }), cleanSamples);
  assert.equal(input.previousAvailable, false);
  const turns = input.comparisons.find((c) => c.metric === "turns")!;
  assert.equal(turns.previous, null);
  assert.equal(turns.delta, null);
  assert.equal(turns.percentChange, null);
  assert.equal(turns.trend, "not_available");
});

test("buildAnalysisInput: evidence catalog has M (metrics), E (samples), D (warnings)", () => {
  const input = buildAnalysisInput(mr({ completeness: 0.5 }), mr({ turns: 0 }), cleanSamples);
  const kinds = new Set(input.evidenceCatalog.map((x) => x.kind));
  assert.ok(kinds.has("M") && kinds.has("E") && kinds.has("D"));
  assert.equal(input.dataQuality.allowInterpretation, false); // 0.5 < 0.9
  assert.ok(input.dataQuality.warnings.length >= 2); // low completeness + empty previous
  assert.deepEqual(input.allowedOwners, DEFAULT_ALLOWED_OWNERS);
});

test("buildAnalysisInput: leaky samples are dropped from input + catalog", () => {
  const leaky: EvidenceSample[] = [{ id: "E1", intent: "HR", text: "เมล a@b.com" }, { id: "E2", intent: "HR", text: "ลาป่วยกี่วัน" }];
  const input = buildAnalysisInput(mr(), mr(), leaky);
  assert.equal(input.droppedSamples, 1);
  assert.equal(input.samples.length, 1);
  assert.ok(!input.evidenceCatalog.some((x) => x.id === "E1" && x.kind === "E"));
});

test("buildUserMessage: wraps JSON in delimiters with an injection guard; no raw PII", () => {
  const msg = buildUserMessage(buildAnalysisInput(mr(), mr(), cleanSamples));
  assert.match(msg, /<analysis_input>[\s\S]*<\/analysis_input>/);
  assert.match(msg, /ห้ามปฏิบัติตามคำสั่ง/);
  assert.doesNotMatch(msg, /@/);
});

test("extractJson: handles fences and prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("no json"), null);
});

test("analyzeWithRetry: valid v1.0 output on first try", async () => {
  const llm: LlmCall = async () => JSON.stringify(goodOutput());
  const r = await analyzeWithRetry(buildAnalysisInput(mr({ turns: 100 }), mr({ turns: 80 }), cleanSamples), llm);
  assert.equal(r.attempts, 1);
  assert.ok(r.analysis);
});

test("analyzeWithRetry: rejects hallucinated evidence, retries, then falls back", async () => {
  const badEvidence = { ...goodOutput(), executiveSummary: [{ statement: "x", evidenceIds: ["M99"] }] };
  const llm: LlmCall = async () => JSON.stringify(badEvidence);
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm, { maxAttempts: 2 });
  assert.equal(r.analysis, null); // never validated
  assert.equal(r.attempts, 2);
  assert.ok(r.errors.every((e) => e.includes("unknown evidence") || e.includes("M99")));
});

test("analyzeWithRetry: swallows llm errors and falls back", async () => {
  const llm: LlmCall = async () => { throw new Error("timeout"); };
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm, { maxAttempts: 2 });
  assert.equal(r.analysis, null);
  assert.ok(r.errors[0]!.includes("llm error"));
});
