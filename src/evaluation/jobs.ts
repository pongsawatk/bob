import { randomUUID } from 'node:crypto';
import { Client } from '@upstash/qstash';
import { getRedis } from '../store/redis.js';
import { env } from '../env.js';
import { callLLM } from '../llm/openrouter.js';
import { ARMS, type ExperimentArm } from '../llm/modelConfig.js';
import type { EvaluationSnapshot } from '../llm/experimentContext.js';
import { guardEligibility } from '../prompts/systemPolicy.js';
import { validateITAnswer } from '../kb/itAnswer.js';
import { withBudget } from '../http/budget.js';
import { getDirectoryNames } from '../people/directory.js';
import { getEvaluationConfig, sampled, type EvaluationConfig } from './config.js';
import { redactReviewText, reviewWithJev } from './jev.js';

const PREFIX = 'bob:eval:v1:';
const TOTAL_KEY = `${PREFIX}budget:total:quality1`;
const RESULT_TTL = 7 * 86400;
export interface EvaluationJob {
  id: string; traceId: string; arm: ExperimentArm; createdAt: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  snapshot?: EvaluationSnapshot;
  reason?: string;
  result?: Record<string, unknown>;
  review?: { winner: 'baseline' | 'candidate' | 'tie' | 'unjudgeable'; comment: string; reviewedAt: string };
}
const key = (id: string) => `${PREFIX}job:${id}`;
export async function getEvaluationJob(id: string): Promise<EvaluationJob | null> {
  return await getRedis()?.get<EvaluationJob>(key(id)) ?? null;
}
export async function listEvaluationJobs(): Promise<EvaluationJob[]> {
  const r = getRedis(); if (!r) return [];
  const ids = await r.zrange<string[]>(`${PREFIX}index`, 0, 99, { rev: true });
  if (!ids.length) return [];
  const rows = await r.mget<(EvaluationJob | null)[]>(...ids.map(key));
  return rows.filter((j): j is EvaluationJob => j !== null).map(({ snapshot, ...j }) => j);
}
export async function evaluationBudget() {
  const r = getRedis();
  if (!r) return null;
  const [day, total] = await Promise.all([
    r.hgetall(`${PREFIX}budget:${new Date().toISOString().slice(0, 10)}`), r.hgetall(TOTAL_KEY),
  ]);
  return { dayUtc: new Date().toISOString().slice(0, 10), day, total };
}
export async function saveHumanReview(id: string, review: NonNullable<EvaluationJob['review']>): Promise<void> {
  const r = getRedis(); const job = await getEvaluationJob(id);
  if (!r || !job || job.status !== 'complete') throw new Error('Completed evaluation not found');
  await r.set(key(id), { ...job, review }, { ex: RESULT_TTL });
}

/** Only the job ID travels through QStash. The snapshot stays in existing Redis. */
export async function enqueueEvaluation(snapshot: EvaluationSnapshot, traceId: string, config: EvaluationConfig): Promise<string | undefined> {
  const r = getRedis();
  if (!r || !sampled(config, traceId)) return;
  // No comparison against itself. Pilot answers get a Sonnet 5 control replay.
  const arm: ExperimentArm = snapshot.result.requestedModel === ARMS[config.arm].model ? 'sonnet5-medium' : config.arm;
  const id = randomUUID();
  const job: EvaluationJob = { id, traceId, arm, createdAt: new Date().toISOString(), status: 'pending', snapshot };
  await r.set(key(id), job, { ex: 86400 });
  await r.zadd(`${PREFIX}index`, { score: Date.now(), member: id });
  await r.zremrangebyscore(`${PREFIX}index`, 0, Date.now() - RESULT_TTL * 1000);
  if (env.QSTASH_TOKEN) {
    try {
      await new Client({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL || undefined }).publishJSON({
        url: process.env.BOB_EVAL_WORKER_URL || 'https://bob-sidekick.vercel.app/api/evaluation/worker',
        body: { jobId: id }, retries: 2,
      });
    } catch { console.warn('[evaluation] queue unavailable; durable job awaits admin drain'); }
  }
  return id;
}

const RESERVE = `
local day = tonumber(redis.call('HGET', KEYS[1], 'calls') or '0')
local total = tonumber(redis.call('HGET', KEYS[2], 'calls') or '0')
local dayCost = tonumber(redis.call('HGET', KEYS[1], 'reservedUsd') or '0')
local totalCost = tonumber(redis.call('HGET', KEYS[2], 'reservedUsd') or '0')
if day >= tonumber(ARGV[1]) or total >= tonumber(ARGV[2]) or dayCost + 1 > tonumber(ARGV[3]) or totalCost + 1 > tonumber(ARGV[4]) then return 0 end
for _,k in ipairs(KEYS) do redis.call('HINCRBY', k, 'calls', 1); redis.call('HINCRBYFLOAT', k, 'reservedUsd', 1) end
redis.call('EXPIRE', KEYS[1], 172800)
return 1`;

/** Separate invocation: never appends history, sends Teams messages, or reroutes. */
export async function processEvaluation(id: string): Promise<EvaluationJob | null> {
  const r = getRedis(); if (!r) return null;
  const lease = `${PREFIX}lease:${id}`;
  if (!await r.set(lease, randomUUID(), { nx: true, ex: 70 })) return getEvaluationJob(id);
  const job = await getEvaluationJob(id);
  if (!job || !['pending', 'running'].includes(job.status) || !job.snapshot) return job;
  const config = await getEvaluationConfig();
  const finish = async (status: EvaluationJob['status'], reason?: string, result?: Record<string, unknown>) => {
    const { snapshot, ...rest } = job;
    const final: EvaluationJob = { ...rest, status, reason, result };
    await r.set(key(id), final, { ex: RESULT_TTL });
    return final;
  };
  // A prior invocation outlived its lease. Its billing is unknown: do not call again.
  if (job.status === 'running') return finish('failed', 'interrupted_billing_unknown');
  if (config.mode === 'off') return finish('skipped', 'disabled');
  const snapshot = job.snapshot;
  if (Buffer.byteLength(JSON.stringify(snapshot.options)) > 160000 || (snapshot.options.maxTokens ?? 1000) > 4096) return finish('skipped', 'context_exceeds_cost_bound');
  const dayKey = `${PREFIX}budget:${new Date().toISOString().slice(0, 10)}`;
  if (!await r.eval(RESERVE, [dayKey, TOTAL_KEY], [config.dailyMaxCalls, config.totalMaxCalls, config.dailyMaxUsd, config.totalMaxUsd])) return finish('skipped', 'budget');
  await r.set(key(id), { ...job, status: 'running' }, { ex: 86400 });
  let charged: number | null = null;
  try {
    const result = await withBudget(35000, () => callLLM({ ...snapshot.options, ...ARMS[job.arm],
      cacheSystem: false, strictProvider: true, maxPrice: { prompt: 4, completion: 10 }, retries: 0, timeoutMs: 35000 }));
    charged = result.costUsd;
    const checked = snapshot.category === 'IT' ? validateITAnswer(result.text, snapshot.selection) : guardEligibility(result.text);
    const answer = checked.text;
    let jev: Awaited<ReturnType<typeof reviewWithJev>> | undefined;
    if (config.jevEnabled) {
      try {
        const names = await withBudget(2000, () => getDirectoryNames());
        if (!names.length) throw new Error('Redaction directory unavailable');
        jev = await reviewWithJev({ question: redactReviewText(snapshot.options.messages.map(m => m.content).join('\n'), names),
          answer: redactReviewText(answer, names), evidence: redactReviewText(snapshot.selection.bundle, names) });
        if (charged !== null && jev.costUsd !== null) charged += jev.costUsd;
        else if (jev.reason !== 'context_too_large' && jev.reason !== 'missing_input') charged = null;
      } catch { /* Missing redaction data means no third-party review. */ }
    }
    return await finish('complete', undefined, {
      category: snapshot.category, promptVersion: snapshot.promptVersion, promptHash: snapshot.promptHash, kbHash: snapshot.kbHash,
      configVersion: snapshot.configVersion,
      cachePolicy: { baseline: snapshot.options.cacheSystem ?? false, candidate: false },
      sourceClock: snapshot.createdAt, baseline: { ...snapshot.result, text: snapshot.servedAnswer ?? snapshot.result.text },
      candidate: { ...result, rawAnswer: result.text, text: answer, guarded: checked.guarded }, jev: jev ?? { status: 'not_assessed', reason: config.jevEnabled ? 'redaction_unavailable' : 'disabled' },
      comparisonValid: snapshot.result.actualModel === snapshot.result.requestedModel && result.actualModel === ARMS[job.arm].model && snapshot.result.finishReason === 'stop' && result.finishReason === 'stop' && !snapshot.result.fallbackFrom,
      qualityStatus: 'awaiting_human_review',
    });
  } catch { return await finish('failed', 'candidate_call_failed'); }
  finally {
    // Retain the full reservation on unknown billing or a failed call.
    if (charged !== null && charged < 1) await r.eval("for _,k in ipairs(KEYS) do redis.call('HINCRBYFLOAT',k,'reservedUsd',ARGV[1]) end return 1", [dayKey, TOTAL_KEY], [charged - 1]);
  }
}
