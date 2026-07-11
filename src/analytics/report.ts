// WP-11/12 — structured analysis schema v1.0, validation, evidence, and the fixed
// 6-section renderer. The model returns ONLY AnalysisOutput; every number comes from
// code (MetricReport). Validation is strict: every cited evidence id must exist in the
// catalog, owners must be in the allowlist, recommendations are capped and prioritized.
// On any validation failure the caller falls back to numbers-only.

import type { MetricReport } from "./langfuse.js";
import { redact } from "./redact.js";

export const REPORT_TEMPLATE_VERSION = "v1";
export const ANALYSIS_SCHEMA_VERSION = "1.0";
export const DEFAULT_COMPLETENESS_THRESHOLD = 0.9;
export const MAX_RECOMMENDATIONS = 8;

export type Sev = "high" | "medium" | "low";
export type Priority = "P0" | "P1" | "P2";
export type RecType = "kb" | "feature" | "prompt";
export type GapCategory =
  | "knowledge" | "routing" | "prompt" | "truncation" | "latency"
  | "error" | "data_quality" | "privacy" | "other";
const INTENTS = new Set(["HR", "PRODUCT", "GENERAL", "PEOPLE", "UNKNOWN"]);

export interface SummaryItem { statement: string; evidenceIds: string[]; }
export interface TopTopic { intent: string; topic: string; evidenceIds: string[]; }
export interface Gap { id: string; category: GapCategory; statement: string; severity: Sev; evidenceIds: string[]; }
export interface Recommendation {
  id: string; priority: Priority; type: RecType; statement: string;
  evidenceIds: string[]; impact: Sev; effort: Sev; confidence: Sev;
  owner: string | null; dueDate: string | null; status: string;
}
export interface Limitation { statement: string; evidenceIds: string[]; }

export interface AnalysisOutput {
  schemaVersion: string;
  executiveSummary: SummaryItem[];
  topTopics: TopTopic[];
  gaps: Gap[];
  recommendations: Recommendation[];
  limitations: Limitation[];
}

/** A redacted example question, cited by evidence id (E1, E2…). */
export interface EvidenceSample { id: string; intent: string; text: string; }

/** Context the validator needs to enforce grounding: which evidence ids and owners exist. */
export interface ValidateContext { evidenceIds: Set<string>; allowedOwners: string[]; }

export type ValidationResult =
  | { ok: true; value: AnalysisOutput }
  | { ok: false; errors: string[] };

const SEV = new Set<Sev>(["high", "medium", "low"]);
const PRIORITY = new Set<Priority>(["P0", "P1", "P2"]);
const REC_TYPE = new Set<RecType>(["kb", "feature", "prompt"]);
const GAP_CAT = new Set<GapCategory>([
  "knowledge", "routing", "prompt", "truncation", "latency", "error", "data_quality", "privacy", "other",
]);
const isStr = (x: unknown): x is string => typeof x === "string";
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? x : {}) as Record<string, unknown>;

/** Validate evidenceIds: must be a non-empty string[] whose every id exists in the catalog. */
function evErrors(v: unknown, valid: Set<string>, path: string, e: string[]): void {
  if (!Array.isArray(v) || !v.every(isStr)) { e.push(`${path}.evidenceIds must be string[]`); return; }
  for (const id of v as string[]) if (!valid.has(id)) e.push(`${path}.evidenceIds cites unknown evidence "${id}"`);
}

/** Strict schema + grounding check. No external validation library. Collects all errors. */
export function validateAnalysis(raw: unknown, ctx: ValidateContext): ValidationResult {
  const e: string[] = [];
  const o = obj(raw);
  const owners = new Set(ctx.allowedOwners);

  if (!isStr(o.schemaVersion)) e.push("schemaVersion must be a string");

  const arr = (v: unknown, name: string): unknown[] => {
    if (!Array.isArray(v)) { e.push(`${name} must be an array`); return []; }
    return v;
  };

  arr(o.executiveSummary, "executiveSummary").forEach((s, i) => {
    const it = obj(s); const p = `executiveSummary[${i}]`;
    if (!isStr(it.statement) || !it.statement.trim()) e.push(`${p}.statement required`);
    evErrors(it.evidenceIds, ctx.evidenceIds, p, e);
  });

  arr(o.topTopics, "topTopics").forEach((t, i) => {
    const it = obj(t); const p = `topTopics[${i}]`;
    if (!INTENTS.has(it.intent as string)) e.push(`${p}.intent invalid`);
    if (!isStr(it.topic) || !it.topic.trim()) e.push(`${p}.topic required`);
    evErrors(it.evidenceIds, ctx.evidenceIds, p, e);
  });

  arr(o.gaps, "gaps").forEach((g, i) => {
    const it = obj(g); const p = `gaps[${i}]`;
    if (!isStr(it.id)) e.push(`${p}.id required`);
    if (!GAP_CAT.has(it.category as GapCategory)) e.push(`${p}.category invalid`);
    if (!isStr(it.statement) || !it.statement.trim()) e.push(`${p}.statement required`);
    if (!SEV.has(it.severity as Sev)) e.push(`${p}.severity must be high|medium|low`);
    evErrors(it.evidenceIds, ctx.evidenceIds, p, e);
  });

  const recs = arr(o.recommendations, "recommendations");
  if (recs.length > MAX_RECOMMENDATIONS) e.push(`recommendations exceed ${MAX_RECOMMENDATIONS}`);
  recs.forEach((r, i) => {
    const it = obj(r); const p = `recommendations[${i}]`;
    if (!isStr(it.id)) e.push(`${p}.id required`);
    if (!PRIORITY.has(it.priority as Priority)) e.push(`${p}.priority must be P0|P1|P2`);
    if (!REC_TYPE.has(it.type as RecType)) e.push(`${p}.type must be kb|feature|prompt`);
    if (!isStr(it.statement) || !it.statement.trim()) e.push(`${p}.statement required`);
    if (!SEV.has(it.impact as Sev)) e.push(`${p}.impact invalid`);
    if (!SEV.has(it.effort as Sev)) e.push(`${p}.effort invalid`);
    if (!SEV.has(it.confidence as Sev)) e.push(`${p}.confidence invalid`);
    if (!(it.owner === null || (isStr(it.owner) && owners.has(it.owner)))) e.push(`${p}.owner must be null or in allowedOwners`);
    if (!(it.dueDate === null || isStr(it.dueDate))) e.push(`${p}.dueDate must be null or a string`);
    if (it.status !== "proposed") e.push(`${p}.status must be "proposed"`);
    evErrors(it.evidenceIds, ctx.evidenceIds, p, e);
  });

  arr(o.limitations, "limitations").forEach((l, i) => {
    const it = obj(l); const p = `limitations[${i}]`;
    if (!isStr(it.statement) || !it.statement.trim()) e.push(`${p}.statement required`);
    evErrors(it.evidenceIds, ctx.evidenceIds, p, e);
  });

  return e.length ? { ok: false, errors: e } : { ok: true, value: raw as AnalysisOutput };
}

/** Build bounded, redacted evidence samples from raw traces whose ids are selected. */
export function sampleEvidence(
  raws: { id: string; input?: unknown; metadata?: unknown }[],
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
    const md = obj(raw.metadata);
    out.push({ id: `E${out.length + 1}`, intent: isStr(md.category) ? md.category : "OTHER", text: redact(raw.input, { names: opts.names }).text });
  }
  return out;
}

// ── Renderer ───────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const arrow = (c: number, p: number) => { const d = c - p; return `${d > 0 ? "▲+" : d < 0 ? "▼" : "="}${d === 0 ? "" : Math.abs(d)}`; };
const ev = (ids: string[]) => (ids.length ? ` _(${ids.join(",")})_` : "");
const PRIORITY_ORDER: Priority[] = ["P0", "P1", "P2"];

export interface RenderOpts {
  current: MetricReport;
  previous: MetricReport;
  analysis: AnalysisOutput | null;
  samples: EvidenceSample[];
  templateVersion?: string;
  completenessThreshold?: number;
}

/** Render the fixed 6-section report. Numbers (§2) + appendix (§6) always render; AI
 *  sections degrade to a notice when analysis is null or completeness is below floor. */
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
  L.push(`template ${ver} · schema ${ANALYSIS_SCHEMA_VERSION} · window ${c.window.from.slice(0, 10)} → ${c.window.to.slice(0, 10)} · completeness ${pct(c.completeness)}`);
  if (partial) L.push(`\n> ⚠️ **PARTIAL DATA** (completeness ${pct(c.completeness)} < ${pct(threshold)}). Decision-grade conclusions are suppressed.`);

  L.push(`\n## 1. Executive Summary`);
  if (analysis && !partial && analysis.executiveSummary.length) analysis.executiveSummary.forEach((b) => L.push(`- ${b.statement}${ev(b.evidenceIds)}`));
  else L.push(notice);

  L.push(`\n## 2. ตัวเลขหลัก vs ช่วงก่อนหน้า`);
  // A previous window with zero turns = no data to compare against → show N/A, not 0.
  const prevEmpty = p.turns === 0;
  const pv = (s: string) => (prevEmpty ? "N/A" : s);
  const dv = (cur: number, prev: number) => (prevEmpty ? "N/A" : arrow(cur, prev));
  L.push(`| metric | current | prev | Δ |`);
  L.push(`|---|--:|--:|--:|`);
  L.push(`| turns | ${c.turns} | ${pv(String(p.turns))} | ${dv(c.turns, p.turns)} |`);
  L.push(`| unique users | ${c.uniqueUsers} | ${pv(String(p.uniqueUsers))} | ${dv(c.uniqueUsers, p.uniqueUsers)} |`);
  L.push(`| repeat users (≥2d) | ${c.repeatUsers} (${pct(c.repeatUserRate)}) | ${pv(`${p.repeatUsers} (${pct(p.repeatUserRate)})`)} | ${dv(c.repeatUsers, p.repeatUsers)} |`);
  L.push(`| one-shot rate | ${pct(c.oneShotRate)} | ${pv(pct(p.oneShotRate))} | — |`);
  L.push(`| UNKNOWN turns | ${c.unknownTurns} | ${pv(String(p.unknownTurns))} | ${dv(c.unknownTurns, p.unknownTurns)} |`);
  L.push(`| truncated | ${c.truncatedTurns} | ${pv(String(p.truncatedTurns))} | ${dv(c.truncatedTurns, p.truncatedTurns)} |`);
  L.push(`| latency p50 / p95 | ${sec(c.latencyP50Ms)} / ${sec(c.latencyP95Ms)} | ${pv(`${sec(p.latencyP50Ms)} / ${sec(p.latencyP95Ms)}`)} | — |`);
  L.push(`| cost | ${usd(c.costUsd)} | ${pv(usd(p.costUsd))} | — |`);

  L.push(`\n## 3. Top topics ตาม intent`);
  if (analysis && analysis.topTopics.length) analysis.topTopics.forEach((t) => L.push(`- **${t.intent}** — ${t.topic}${ev(t.evidenceIds)}`));
  else L.push(`intent mix: ${Object.entries(c.intents).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  L.push(`\n## 4. Gap Analysis`);
  if (analysis && !partial && analysis.gaps.length) analysis.gaps.forEach((g) => L.push(`- **[${g.severity}/${g.category}]** ${g.statement}${ev(g.evidenceIds)}`));
  else L.push(notice);
  L.push(`- _UNKNOWN not yet split into "no-knowledge" vs "injection blocked" (Metric Contract §3)._`);
  if (analysis && analysis.limitations.length) { L.push(`\n**ข้อจำกัด:**`); analysis.limitations.forEach((l) => L.push(`- ${l.statement}${ev(l.evidenceIds)}`)); }

  L.push(`\n## 5. ข้อเสนอปรับปรุง (P0–P2)`);
  if (analysis && !suppressed && analysis.recommendations.length) {
    [...analysis.recommendations]
      .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
      .forEach((r) =>
        L.push(
          `- **${r.priority} [${r.type}]** ${r.statement}  \n` +
            `  impact=${r.impact} effort=${r.effort} confidence=${r.confidence} · owner=${r.owner ?? "—"} · due=${r.dueDate ?? "—"} · status=${r.status} · evidence=${r.evidenceIds.join(",") || "—"}`
        )
      );
  } else L.push(suppressed ? notice : "_No recommendations._");

  L.push(`\n## 6. Appendix — ตัวอย่างคำถาม (mask แล้ว)`);
  if (samples.length) samples.forEach((s) => L.push(`- \`${s.id}\` [${s.intent}] ${s.text}`));
  else L.push("_No samples._");

  return L.join("\n");
}
