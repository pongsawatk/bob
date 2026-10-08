import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../../src/env.js';
import { getEvaluationConfig, setEvaluationConfig, validateConfig } from '../../src/evaluation/config.js';
import { evaluationBudget, getEvaluationJob, listEvaluationJobs, processEvaluation, saveHumanReview } from '../../src/evaluation/jobs.js';
import { ARMS, MODEL_CONFIG_VERSION } from '../../src/llm/modelConfig.js';

export const config = { maxDuration: 60 };
export function authorizedEvaluation(header: unknown): boolean {
  // Reuses the deployment's existing admin test secret. No public write path.
  if (typeof header !== 'string') return false;
  return [env.CHAT_TEST_KEY, env.CRON_SECRET].filter(Boolean).some(expected => {
    const a = Buffer.from(header); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorizedEvaluation(req.headers['x-test-key'])) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const body = req.body ?? {};
  try {
    if (body.action === 'status') {
      const c = await getEvaluationConfig();
      res.status(200).json({ config: { ...c, pilotUsers: c.pilotUsers.map(() => '[configured]') }, arms: ARMS, version: MODEL_CONFIG_VERSION, budget: await evaluationBudget(), jobs: await listEvaluationJobs() }); return;
    }
    if (body.action === 'configure') {
      if (!validateConfig(body.config)) { res.status(400).json({ error: 'Invalid configuration' }); return; }
      await setEvaluationConfig(body.config);
      res.status(200).json({ ok: true, mode: body.config.mode }); return;
    }
    if (!/^[0-9a-f-]{36}$/.test(body.jobId ?? '')) { res.status(400).json({ error: 'Invalid job ID' }); return; }
    if (body.action === 'process') {
      const job = await processEvaluation(body.jobId);
      res.status(200).json({ id: job?.id, status: job?.status }); return;
    }
    if (body.action === 'review' && ['baseline', 'candidate', 'tie', 'unjudgeable'].includes(body.winner) && typeof body.comment === 'string' && body.comment.length <= 2000) {
      await saveHumanReview(body.jobId, { winner: body.winner, comment: body.comment, reviewedAt: new Date().toISOString() });
      res.status(200).json({ ok: true }); return;
    }
    if (body.action === 'get') {
      const job = await getEvaluationJob(body.jobId);
      // Raw snapshots include per-user context; serve completed results only.
      if (!job || job.snapshot) { res.status(404).end(); return; }
      res.status(200).json(job); return;
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch { res.status(503).json({ error: 'Evaluation service unavailable' }); }
}
