// WP-11 — structured analysis schema, validation, evidence mapping, and the fixed
// 6-section report renderer (spec §1 Report Template). The LLM returns ONLY the
// structured AnalysisOutput; every number in the report comes from code (MetricReport).
// If the model output fails validation, the renderer falls back to numbers-only.

import type { MetricReport, RawTrace } from "./langfuse.js";
import { redact } from "./redact.js";

export const REPORT_TEMPLATE_VERSION = "v1";
export const DEFAULT_COMPLETENESS_THRESHOLD = 0.9;

export type Sev = "high" | "medium" | "low";
export type RecType = "kb" | "feature" | "prompt";

/** A closed-loop improvement item — must carry evidence + impact/effort/confidence
 *  + owner/status so it can be tracked before→after in the next report (spec §2.8). */
export interface Recommendation {
  id: string;
  type: RecType;
  statement: string;
  evidenceIds: string[];
  impact: Sev;
  effort: Sev;
  confidence: Sev;
  owner?: string;
  status: string;
}

export interface AnalysisOutput {
  executiveSummary: string[]; // <= 5 bullets
  topTopics: { intent: string; examples: string[] }[];
  gaps: string[];
  recommendations: Recommendation[];
}

/** A redacted example question, referenced by recommendations via its id (E1, E2…). */
export interface EvidenceSample {
  id: string;
  intent: string;
  text: string; // already redacted
}

export type ValidationResult =
  | { ok: true; value: AnalysisOutput }
  | { ok: false; errors: string[] };

const SEV = new Set<Sev>(["high", "medium", "low"]);
const REC_TYPE = new Set<RecType>(["kb", "feature", "prompt"]);
const isStr = (x: unknown): x is string => typeof x === "string";
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);

/** Strict, deterministic schema check for the model's JSON. No dependency on any
 *  validation library. Collects all errors rather than throwing on the first. */
export function validateAnalysis(raw: unknown): ValidationResult {
  const e: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  if (!isStrArr(o.executiveSummary)) e.push("executiveSummary must be string[]");
  else if (o.executiveSummary.length < 1 || o.executiveSummary.length > 5)
    e.push("executiveSummary must have 1–5 bullets");

  if (!Array.isArray(o.topTopics)) e.push("topTopics must be an array");
  else
    o.topTopics.forEach((t, i) => {
      const tt = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
      if (!isStr(tt.intent)) e.push(`topTopics[${i}].intent must be string`);
      if (!isStrArr(tt.examples)) e.push(`topTopics[${i}].examples must be string[]`);
    });

  if (!isStrArr(o.gaps)) e.push("gaps must be string[]");

  if (!Array.isArray(o.recommendations)) e.push("recommendations must be an array");
  else
    o.recommendations.forEach((r, i) => {
      const rr = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      if (!isStr(rr.id)) e.push(`recommendations[${i}].id must be string`);
      if (!REC_TYPE.has(rr.type as RecType)) e.push(`recommendations[${i}].type must be kb|feature|prompt`);
      if (!isStr(rr.statement) || !rr.statement.trim()) e.push(`recommendations[${i}].statement required`);
      if (!isStrArr(rr.evidenceIds)) e.push(`recommendations[${i}].evidenceIds must be string[]`);
      if (!SEV.has(rr.impact as Sev)) e.push(`recommendations[${i}].impact must be high|medium|low`);
      if (!SEV.has(rr.effort as Sev)) e.push(`recommendations[${i}].effort must be high|medium|low`);
      if (!SEV.has(rr.confidence as Sev)) e.push(`recommendations[${i}].confidence must be high|medium|low`);
      if (!isStr(rr.status) || !rr.status.trim()) e.push(`recommendations[${i}].status required`);
    });

  return e.length ? { ok: false, errors: e } : { ok: true, value: raw as AnalysisOutput };
}

/** Evidence ids a recommendation references that don't exist in the sample set. */
export function crossCheckEvidence(analysis: AnalysisOutput, samples: EvidenceSample[]): string[] {
  const known = new Set(samples.map((s) => s.id));
  const dangling = new Set<string>();
  for (const r of analysis.recommendations)
    for (const id of r.evidenceIds) if (!known.has(id)) dangling.add(id);
  return [...dangling];
}

/** Build bounded, redacted evidence samples from raw traces whose ids are selected
 *  (e.g. the UNKNOWN / truncated turns). Input text NEVER leaves here un-redacted. */
export function sampleEvidence(
  raws: RawTrace[],
  turnIds: string[],
  opts: { names?: string[]; max?: number } = {}
): EvidenceSample[] {
  const max = opts.max ?? 10;
  const byId = new Map(raws.map((r) => [r.id, r]));
  const out: EvidenceSample[] = [];
  for (const tid of turnIds) {
    if (out.length >= max) break;
    const raw = byId.get(tid);
    if (!raw) continue;
    const md = (raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>;
    out.push({
      id: `E${out.length + 1}`,
      intent: typeof md.category === "string" ? md.category : "OTHER",
      text: redact(raw.input, { names: opts.names }).text,
    });
  }
  return out;
}

// ── Renderer ───────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const arrow = (cur: number, prev: number) => {
  const d = cur - prev;
  return `${d > 0 ? "▲+" : d < 0 ? "▼" : "="}${d === 0 ? "" : Math.abs(d)}`;
};

export interface RenderOpts {
  current: MetricReport;
  previous: MetricReport;
  analysis: AnalysisOutput | null; // null → validation failed / model unavailable
  samples: EvidenceSample[];
  templateVersion?: string;
  completenessThreshold?: number;
}

/** Render the fixed 6-section report. Numbers (§2) and appendix (§6) always render;
 *  AI-derived sections degrade to a clear notice when analysis is null or data is
 *  partial (spec §4.5: no decision-grade conclusions below the completeness floor). */
export function renderReport(opts: RenderOpts): string {
  const { current: c, previous: p, analysis, samples } = opts;
  const ver = opts.templateVersion ?? REPORT_TEMPLATE_VERSION;
  const threshold = opts.completenessThreshold ?? DEFAULT_COMPLETENESS_THRESHOLD;
  const partial = c.completeness < threshold;
  const suppressed = partial || !analysis;
  const notice = !analysis
    ? "_AI analysis unavailable — showing verified numbers only._"
    : "_Conclusions suppressed: data completeness below threshold (partial data)._";

  const L: string[] = [];
  L.push(`# BOB Insight Report — ${c.window.days}d`);
  L.push(`template ${ver} · window ${c.window.from.slice(0, 10)} → ${c.window.to.slice(0, 10)} · completeness ${pct(c.completeness)}`);
  if (partial) L.push(`\n> ⚠️ **PARTIAL DATA** (completeness ${pct(c.completeness)} < ${pct(threshold)}). Treat conclusions with care; decision-grade recommendations are suppressed.`);

  L.push(`\n## 1. Executive Summary`);
  if (analysis && !partial) analysis.executiveSummary.forEach((b) => L.push(`- ${b}`));
  else L.push(notice);

  L.push(`\n## 2. ตัวเลขหลัก vs ช่วงก่อนหน้า`);
  L.push(`| metric | current | prev | Δ |`);
  L.push(`|---|--:|--:|--:|`);
  L.push(`| turns | ${c.turns} | ${p.turns} | ${arrow(c.turns, p.turns)} |`);
  L.push(`| unique users | ${c.uniqueUsers} | ${p.uniqueUsers} | ${arrow(c.uniqueUsers, p.uniqueUsers)} |`);
  L.push(`| repeat users (≥2d) | ${c.repeatUsers} (${pct(c.repeatUserRate)}) | ${p.repeatUsers} (${pct(p.repeatUserRate)}) | ${arrow(c.repeatUsers, p.repeatUsers)} |`);
  L.push(`| one-shot rate | ${pct(c.oneShotRate)} | ${pct(p.oneShotRate)} | — |`);
  L.push(`| UNKNOWN turns | ${c.unknownTurns} | ${p.unknownTurns} | ${arrow(c.unknownTurns, p.unknownTurns)} |`);
  L.push(`| truncated | ${c.truncatedTurns} | ${p.truncatedTurns} | ${arrow(c.truncatedTurns, p.truncatedTurns)} |`);
  L.push(`| latency p50 / p95 | ${s(c.latencyP50Ms)} / ${s(c.latencyP95Ms)} | ${s(p.latencyP50Ms)} / ${s(p.latencyP95Ms)} | — |`);
  L.push(`| cost | ${usd(c.costUsd)} | ${usd(p.costUsd)} | — |`);

  L.push(`\n## 3. Top topics ตาม intent`);
  if (analysis) analysis.topTopics.forEach((t) => L.push(`- **${t.intent}** — ${t.examples.join("; ")}`));
  else L.push(`intent mix: ${Object.entries(c.intents).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  L.push(`\n## 4. Gap Analysis`);
  if (analysis && !partial) analysis.gaps.forEach((g) => L.push(`- ${g}`));
  else L.push(notice);
  L.push(`- _UNKNOWN not yet split into "no-knowledge" vs "injection blocked" (Metric Contract §3)._`);

  L.push(`\n## 5. ข้อเสนอปรับปรุง (P0–P2)`);
  if (analysis && !suppressed && analysis.recommendations.length) {
    analysis.recommendations.forEach((r) =>
      L.push(
        `- **[${r.type}]** ${r.statement}  \n` +
          `  impact=${r.impact} effort=${r.effort} confidence=${r.confidence} · owner=${r.owner ?? "—"} · status=${r.status} · evidence=${r.evidenceIds.join(",") || "—"}`
      )
    );
  } else L.push(suppressed ? notice : "_No recommendations._");

  L.push(`\n## 6. Appendix — ตัวอย่างคำถาม (mask แล้ว)`);
  if (samples.length) samples.forEach((s) => L.push(`- \`${s.id}\` [${s.intent}] ${s.text}`));
  else L.push("_No samples._");

  return L.join("\n");
}
