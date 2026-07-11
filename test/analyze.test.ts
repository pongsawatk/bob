// WP-12 slice 2 — analyze stage: PII-safe input building + validate/retry/fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisInput,
  serializeAnalysisInput,
  extractJson,
  analyzeWithRetry,
  type LlmCall,
} from "../src/analytics/analyze.ts";
import type { MetricReport } from "../src/analytics/langfuse.ts";
import type { AnalysisOutput, EvidenceSample } from "../src/analytics/report.ts";

const mr = (o: Partial<MetricReport> = {}): MetricReport => ({
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-08T00:00:00.000Z", days: 7 },
  completeness: 1, turns: 100, uniqueUsers: 40, sessions: 60, repeatUsers: 12,
  repeatUserRate: 0.3, oneShotRate: 0.59, intents: { HR: 50, GENERAL: 30, UNKNOWN: 5 },
  unknownTurns: 5, truncatedTurns: 3, fromCacheTurns: 20, latencyP50Ms: 3000, latencyP95Ms: 9000,
  costUsd: 0.5, ...o,
});

const cleanSamples: EvidenceSample[] = [
  { id: "E1", intent: "UNKNOWN", text: "ลาพักร้อนเหลือกี่วัน" },
  { id: "E2", intent: "HR", text: "เบิกค่าทันตกรรมยังไง" },
];

const goodAnalysis: AnalysisOutput = {
  executiveSummary: ["ผู้ใช้เพิ่มขึ้น"],
  topTopics: [{ intent: "HR", examples: ["ลาป่วย"] }],
  gaps: ["ลาพักร้อนคงเหลือตอบไม่ได้"],
  recommendations: [{ id: "R1", type: "kb", statement: "เพิ่ม KB", evidenceIds: ["E1"], impact: "high", effort: "low", confidence: "high", status: "proposed" }],
};

test("buildAnalysisInput: aggregates are numbers-only; leaky samples are dropped", () => {
  const leaky: EvidenceSample[] = [
    { id: "E1", intent: "HR", text: "ส่งเมลไป a@b.com" }, // still contains an email → must be dropped
    { id: "E2", intent: "HR", text: "ลาป่วยกี่วัน" },
  ];
  const input = buildAnalysisInput(mr(), mr({ turns: 80 }), leaky);
  assert.equal(input.droppedSamples, 1);
  assert.equal(input.samples.length, 1);
  assert.equal(input.samples[0]!.id, "E2");
  assert.equal(input.current.turns, 100);
  assert.equal(input.previous.turns, 80);
});

test("serializeAnalysisInput: PII-free JSON with numbers + sample ids", () => {
  const s = serializeAnalysisInput(buildAnalysisInput(mr(), mr(), cleanSamples));
  assert.doesNotMatch(s, /@/); // no emails/mentions
  assert.match(s, /"turns":100/);
  assert.match(s, /"E1"/);
});

test("extractJson: handles fenced and prose-wrapped JSON", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sure, here:\n{"a":2} done'), { a: 2 });
  assert.equal(extractJson("no json here"), null);
});

test("analyzeWithRetry: valid output on first try", async () => {
  const llm: LlmCall = async () => JSON.stringify(goodAnalysis);
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm);
  assert.equal(r.attempts, 1);
  assert.ok(r.analysis);
  assert.deepEqual(r.danglingEvidence, []); // E1 exists in samples
});

test("analyzeWithRetry: retries past invalid output then succeeds", async () => {
  let n = 0;
  const llm: LlmCall = async () => (++n === 1 ? "garbage, no json" : JSON.stringify(goodAnalysis));
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm);
  assert.equal(r.attempts, 2);
  assert.ok(r.analysis);
  assert.equal(r.errors.length, 1);
});

test("analyzeWithRetry: falls back to null after maxAttempts of bad output", async () => {
  const llm: LlmCall = async () => '{"executiveSummary": "not an array"}'; // schema-invalid
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm, { maxAttempts: 2 });
  assert.equal(r.analysis, null);
  assert.equal(r.attempts, 2);
  assert.equal(r.errors.length, 2);
});

test("analyzeWithRetry: swallows llm errors and falls back", async () => {
  const llm: LlmCall = async () => { throw new Error("timeout"); };
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm, { maxAttempts: 2 });
  assert.equal(r.analysis, null);
  assert.ok(r.errors[0]!.includes("llm error"));
});

test("analyzeWithRetry: reports dangling evidence ids the model invented", async () => {
  const bad = { ...goodAnalysis, recommendations: [{ ...goodAnalysis.recommendations[0]!, evidenceIds: ["E1", "E99"] }] };
  const llm: LlmCall = async () => JSON.stringify(bad);
  const r = await analyzeWithRetry(buildAnalysisInput(mr(), mr(), cleanSamples), llm);
  assert.ok(r.analysis);
  assert.deepEqual(r.danglingEvidence, ["E99"]);
});
