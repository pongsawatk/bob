// WP-12 slice 2 — the analyze stage, LLM-agnostic + PII-safe.
// buildAnalysisInput assembles the ONLY thing the model ever sees: code-computed
// aggregates + already-redacted evidence samples (defense-in-depth: samples that
// still trip findLeaks are dropped). analyzeWithRetry calls an injected llmCall,
// parses/validates against the WP-11 schema, retries a bounded number of times, and
// falls back to null → the renderer emits numbers-only (spec §4.5). The real prompt
// lives in Langfuse (label `production`, WP-12 slice 5); this module is the plumbing.

import type { MetricReport } from "./langfuse.js";
import { findLeaks } from "./redact.js";
import { validateAnalysis, crossCheckEvidence, type AnalysisOutput, type EvidenceSample } from "./report.js";

/** Curated, all-numeric snapshot of a window — nothing here can carry PII. */
export interface MetricSnapshot {
  turns: number;
  uniqueUsers: number;
  sessions: number;
  repeatUsers: number;
  repeatUserRate: number;
  oneShotRate: number;
  intents: Record<string, number>;
  unknownTurns: number;
  truncatedTurns: number;
  fromCacheTurns: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  costUsd: number;
  completeness: number;
}

export interface AnalysisInput {
  window: { days: number; from: string; to: string };
  current: MetricSnapshot;
  previous: MetricSnapshot;
  samples: EvidenceSample[]; // redacted; each guaranteed leak-free by buildAnalysisInput
  droppedSamples: number; // samples excluded because they still tripped findLeaks
}

function snapshot(r: MetricReport): MetricSnapshot {
  return {
    turns: r.turns,
    uniqueUsers: r.uniqueUsers,
    sessions: r.sessions,
    repeatUsers: r.repeatUsers,
    repeatUserRate: r.repeatUserRate,
    oneShotRate: r.oneShotRate,
    intents: r.intents,
    unknownTurns: r.unknownTurns,
    truncatedTurns: r.truncatedTurns,
    fromCacheTurns: r.fromCacheTurns,
    latencyP50Ms: r.latencyP50Ms,
    latencyP95Ms: r.latencyP95Ms,
    costUsd: r.costUsd,
    completeness: r.completeness,
  };
}

/** Build the model input. Aggregates are numbers-only; samples are re-checked with
 *  findLeaks and any that still leak are dropped (never sent to the LLM). */
export function buildAnalysisInput(
  current: MetricReport,
  previous: MetricReport,
  samples: EvidenceSample[]
): AnalysisInput {
  const safe: EvidenceSample[] = [];
  let dropped = 0;
  for (const s of samples) {
    if (findLeaks(s.text).length === 0) safe.push(s);
    else dropped++;
  }
  return {
    window: { days: current.window.days, from: current.window.from, to: current.window.to },
    current: snapshot(current),
    previous: snapshot(previous),
    samples: safe,
    droppedSamples: dropped,
  };
}

/** Compact JSON the Langfuse prompt operates on. PII-free by construction. */
export function serializeAnalysisInput(input: AnalysisInput): string {
  return JSON.stringify({
    window: input.window,
    current: input.current,
    previous: input.previous,
    samples: input.samples.map((s) => ({ id: s.id, intent: s.intent, text: s.text })),
  });
}

/** Pulls a JSON object out of raw model text (tolerates ```json fences / prose). */
export function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Injected LLM boundary: takes the serialized input, returns raw model text. */
export type LlmCall = (userContent: string) => Promise<string>;

export interface AnalyzeResult {
  analysis: AnalysisOutput | null; // null → renderer falls back to numbers-only
  attempts: number;
  danglingEvidence: string[]; // evidence ids the model cited that don't exist
  errors: string[];
}

/** Call the model, validate against the WP-11 schema, retry on bad output, then fall
 *  back to null. Never throws — a broken model must not break the report. */
export async function analyzeWithRetry(
  input: AnalysisInput,
  llm: LlmCall,
  opts: { maxAttempts?: number } = {}
): Promise<AnalyzeResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const userContent = serializeAnalysisInput(input);
  const errors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await llm(userContent);
    } catch (e) {
      errors.push(`attempt ${attempt}: llm error: ${String(e).slice(0, 80)}`);
      continue;
    }
    const parsed = extractJson(raw);
    if (parsed == null) {
      errors.push(`attempt ${attempt}: no JSON object in output`);
      continue;
    }
    const v = validateAnalysis(parsed);
    if (!v.ok) {
      errors.push(`attempt ${attempt}: ${v.errors.slice(0, 3).join("; ")}`);
      continue;
    }
    return {
      analysis: v.value,
      attempts: attempt,
      danglingEvidence: crossCheckEvidence(v.value, input.samples),
      errors,
    };
  }
  return { analysis: null, attempts: maxAttempts, danglingEvidence: [], errors };
}
