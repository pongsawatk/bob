// WP-12 slice 4 (DRAFT) — QStash worker. Runs ONE stage per invocation under a ~45s
// budget, checkpoints to Redis, enqueues the next stage. INERT until INSIGHT_ENABLED=1
// and the QSTASH_* envs are set. Every request must carry a valid QStash signature.
//
// NOT yet activated end-to-end: needs QStash creds + INSIGHT_WORKER_URL, the deliver
// stage depends on spike #3, and name-level redaction needs a directory-names accessor
// (structured PII — email/phone/id/token — is already masked). Gated off = safe to ship.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../../src/env.js";
import { getRedis } from "../../src/store/redis.js";
import { callLLM } from "../../src/llm/openrouter.js";
import { getPrompt } from "../../src/prompts/langfusePrompts.js";
import {
  Deadline, DEFAULT_WORKER_BUDGET_MS, nextFetchStep, stageClaimTag,
  type JobRecord, type FetchCursor,
} from "../../src/analytics/job.js";
import { RedisJobStore } from "../../src/analytics/jobStoreRedis.js";
import { insightEnabled, verifyQStash, enqueueStage } from "../../src/analytics/queue.js";
import {
  fetchTracesPage, normalizeAll, aggregate,
  type NormalizedTurn, type RawTrace,
} from "../../src/analytics/langfuse.js";
import { redact } from "../../src/analytics/redact.js";
import { getDirectoryNames } from "../../src/people/directory.js";
import { buildAnalysisInput, analyzeWithRetry, type LlmCall } from "../../src/analytics/analyze.js";
import { renderReport, type EvidenceSample } from "../../src/analytics/report.js";
import { reportRedisKey } from "../../src/analytics/reportLink.js";
import { deliverReport } from "../../src/channels/insightDeliver.js";

export const config = { maxDuration: 60 };

interface StageState {
  turns: NormalizedTurn[];
  samples: Array<{ intent: string; text: string }>; // redacted candidate questions
}

async function loadState(ref: string): Promise<StageState> {
  const r = getRedis();
  return (r && (await r.get<StageState>(ref))) || { turns: [], samples: [] };
}
async function saveState(ref: string, s: StageState): Promise<void> {
  const r = getRedis();
  if (r) await r.set(ref, s, { ex: 60 * 60 * 24 });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!insightEnabled()) { res.status(404).json({ error: "disabled" }); return; }

  // QStash authenticity — verify the raw body against the signature header.
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  const sig = req.headers["upstash-signature"];
  const v = await verifyQStash(Array.isArray(sig) ? sig[0] : sig, raw);
  if (!v.ok) { res.status(401).json({ error: "bad signature", reason: v.reason }); return; }

  const { jobId, stage } = (typeof req.body === "object" ? req.body : JSON.parse(raw)) as { jobId: string; stage: string };
  const store = new RedisJobStore();
  const job = await store.get(jobId);
  if (!job) { res.status(200).json({ ok: false, note: "job gone" }); return; } // don't retry a vanished job

  // At-least-once dedup: skip a duplicate delivery of the same (stage[,page]).
  const tag = stageClaimTag(stage as never, stage === "fetch" ? job.cursor?.page : undefined);
  if (!(await store.claimStage(job.jobId, tag))) { res.status(200).json({ ok: true, deduped: true }); return; }

  try {
    const deadline = new Deadline(DEFAULT_WORKER_BUDGET_MS);
    await runStage(job, stage, store, deadline);
    res.status(200).json({ ok: true, jobId, stage });
  } catch (err) {
    await store.releaseClaim(job.jobId, tag); // failed attempt → let QStash retry this stage
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= job.maxAttempts) {
      await store.update(jobId, { status: "failed", attempts, error: String(err).slice(0, 200) });
      res.status(200).json({ ok: false, jobId, note: "max attempts — marked failed" }); // stop QStash retries
    } else {
      await store.update(jobId, { attempts, error: String(err).slice(0, 200) });
      res.status(500).json({ ok: false, jobId, retry: true }); // let QStash retry
    }
  }
}

async function runStage(job: JobRecord, stage: string, store: RedisJobStore, deadline: Deadline): Promise<void> {
  const creds = { host: env.LANGFUSE_HOST, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY };
  // Fetch across BOTH windows [previous.from, current.to] so the comparison has data
  // (aggregate() filters each window itself). Windows are pinned on the job → no drift.
  const fetchWindow = { fromMs: job.windows.previous.fromMs, toMs: job.windows.current.toMs };

  if (stage === "fetch") {
    const state = await loadState(job.stateRef);
    const names = await getDirectoryNames(); // for masking employee names in samples
    let cursor: FetchCursor = job.cursor ?? { page: 1, totalPages: null, fetched: 0 };
    for (;;) {
      const pg = await fetchTracesPage(creds, fetchWindow, cursor.page);
      state.turns.push(...normalizeAll(pg.data));
      collectSamples(pg.data, state, names); // redacted candidates only
      const decision = nextFetchStep(cursor, { page: cursor.page, totalPages: pg.totalPages, count: pg.data.length }, deadline);
      cursor = decision.cursor;
      await saveState(job.stateRef, state);
      await store.update(job.jobId, { cursor, status: "running" });
      if (decision.action === "continue") continue;
      if (decision.action === "yield") { await enqueueStage({ jobId: job.jobId, stage: "fetch" }); return; }
      await store.update(job.jobId, { stage: "aggregate" });
      await enqueueStage({ jobId: job.jobId, stage: "aggregate" });
      return;
    }
  }

  if (stage === "aggregate") {
    // dedupe across pages by id, then hand off to analyze.
    const state = await loadState(job.stateRef);
    const seen = new Set<string>();
    state.turns = state.turns.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
    await saveState(job.stateRef, state);
    await store.update(job.jobId, { stage: "analyze" });
    await enqueueStage({ jobId: job.jobId, stage: "analyze" });
    return;
  }

  if (stage === "analyze") {
    const state = await loadState(job.stateRef);
    const cur = aggregate(state.turns, job.windows.current);
    const prev = aggregate(state.turns, job.windows.previous);
    const samples: EvidenceSample[] = state.samples.slice(0, 10).map((s, i) => ({ id: `E${i + 1}`, intent: s.intent, text: s.text }));
    const input = buildAnalysisInput(cur, prev, samples);

    const { text: sys } = await getPrompt("insight-analysis");
    const model = env.MODEL_INSIGHT || env.MODEL_ASYNC;
    const llm: LlmCall = async (userContent) =>
      (await callLLM({ model, systemPrompt: sys, messages: [{ role: "user", content: userContent }], maxTokens: 2000, temperature: 0.3 })).text;
    // Deadline-aware: won't start an attempt that can't finish in budget → numbers-only.
    const { analysis, errors: analyzeErrors } = await analyzeWithRetry(input, llm, { maxAttempts: 2, deadline, perAttemptMs: 22_000 });

    // Render only the leak-checked subset buildAnalysisInput kept (appendix safety).
    const report = renderReport({ current: cur, previous: prev, analysis, samples: input.samples });
    const r = getRedis();
    const reportRef = reportRedisKey(job.jobId);
    if (r) await r.set(reportRef, report, { ex: 60 * 60 * 24 });
    await store.update(job.jobId, {
      stage: "deliver",
      reportRef,
      status: analysis ? "running" : "partial",
      // Surface WHY the AI section fell back (deadline / llm error / schema invalid) +
      // the model used — visible via /insight-status.
      error: analysis ? undefined : `analyze[${model}] fallback: ${analyzeErrors.slice(0, 2).join(" | ")}`.slice(0, 250),
    });
    await enqueueStage({ jobId: job.jobId, stage: "deliver" });
    return;
  }

  if (stage === "deliver") {
    // Spike #3 decision: summary card + secure link → chunked-text fallback (no file).
    const r = getRedis();
    const report = job.reportRef && r ? await r.get<string>(job.reportRef) : null;
    if (!report) throw new Error("deliver: report missing/expired");
    const outcome = await deliverReport(job, report);
    await store.update(job.jobId, {
      stage: "done",
      status: outcome === "failed" ? "failed" : job.status === "partial" ? "partial" : "completed",
      error: outcome === "failed" ? "delivery failed" : undefined,
    });
    return;
  }
}

/** Add redacted candidate questions (UNKNOWN / truncated turns) for the appendix.
 *  Structured PII (email/phone/id/token) + known employee names are both masked. */
function collectSamples(raws: RawTrace[], state: StageState, names: string[]): void {
  if (state.samples.length >= 20) return;
  for (const t of normalizeAll(raws)) {
    if (state.samples.length >= 20) break;
    if (t.intent === "UNKNOWN" || t.truncated) {
      const raw = raws.find((r) => r.id === t.id);
      if (raw) state.samples.push({ intent: t.intent, text: redact(raw.input, { names }).text });
    }
  }
}
