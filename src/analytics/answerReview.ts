import { normalizeAll, type RawTrace } from './langfuse.js';

import { classifyAnswerShape } from '../pipeline/outcome.js';

export interface FeedbackScore {
  traceId?: string | null;
  name: string;
  value?: number | null;
  stringValue?: string | null;
  timestamp: string;
}

const VERDICTS = new Set(['direct_answer', 'appropriate_gap', 'wrong_request', 'contradicted_evidence', 'unverifiable']);
const repeatKey = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s?？!.]+/g, '');
const count = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };

function reviewCosts(reviewed: Array<{ trace: RawTrace; accepted: boolean }>) {
  const known = reviewed.filter(({ trace }) => trace.costKnown !== false &&
    typeof trace.totalCost === 'number' && Number.isFinite(trace.totalCost) && trace.totalCost >= 0);
  const accepted = reviewed.filter(record => record.accepted).length;
  const cost = known.reduce((sum, record) => sum + (record.trace.totalCost ?? 0), 0);
  const complete = known.length > 0 && known.length === reviewed.length;
  return { reviewed: reviewed.length, accepted, knownCostCount: known.length,
    reviewedCostPerAnswerUsd: complete ? cost / reviewed.length : null,
    reviewedCostPerAcceptedUsd: complete && accepted > 0 ? cost / accepted : null };
}

function latestScores(scores: readonly FeedbackScore[], name: string) {
  const result = new Map<string, FeedbackScore>();
  for (const s of scores) {
    if (!s.traceId || s.name !== name || !Number.isFinite(Date.parse(s.timestamp))) continue;
    if (name === 'user-feedback' ? s.value !== 0 && s.value !== 1 : !VERDICTS.has(s.stringValue ?? '')) continue;
    const previous = result.get(s.traceId);
    if (!previous || Date.parse(s.timestamp) > Date.parse(previous.timestamp)) result.set(s.traceId, s);
  }
  return result;
}

/** No model calls. Only sent Teams responses qualify. Human evidence verdicts
 * come from a reviewer's categorical Langfuse score named answer-review. */
export function reviewSentAnswers(raws: RawTrace[], scores: FeedbackScore[] | null) {
  const byId = new Map(raws.map(t => [t.id, t]));
  const turns = normalizeAll(raws).filter(t => t.channel === 'teams');
  const votes = latestScores(scores ?? [], 'user-feedback');
  const reviews = latestScores(scores ?? [], 'answer-review');
  const humanVerdicts: Record<string, number> = {};
  const signals: Record<string, number> = {};
  const queue: Array<{ traceId: string; reasons: string[] }> = [];
  const previous = new Map<string, { tsMs: number; question: string }>();
  const voted: Array<{ trace: RawTrace; accepted: boolean }> = [];
  const annotated: Array<{ trace: RawTrace; accepted: boolean }> = [];
  let sent = 0, repeatRequests = 0;
  for (const t of turns.sort((a, b) => a.tsMs - b.tsMs)) {
    if (t.deliveryStatus !== 'sent') continue;
    sent++;
    const raw = byId.get(t.id)!;
    const q = typeof raw.input === 'string' ? raw.input : '';
    const a = typeof raw.output === 'string' ? raw.output : '';
    const reasons: string[] = [];
    const mismatch = classifyAnswerShape(q, a, t.intent);
    if (mismatch) reasons.push(mismatch);
    if (t.reviewRequired && !mismatch) reasons.push('runtime_requested_review');
    if (!q || !a) reasons.push('missing_trace_text');

    const conversation = JSON.stringify([t.rawUserId, t.sessionId]);
    const last = previous.get(conversation);
    const question = repeatKey(q);
    if (question && last && question === last.question && t.tsMs - last.tsMs < 15 * 60_000) {
      repeatRequests++;
      reasons.push('consecutive_repeat_within_15m');
    }
    previous.set(conversation, { tsMs: t.tsMs, question });

    const vote = votes.get(t.id);
    if (vote) {
      voted.push({trace: raw, accepted: vote.value === 1});
      if (vote.value === 0) reasons.push('negative_feedback');
    }
    const verdict = reviews.get(t.id)?.stringValue;
    if (verdict) {
      count(humanVerdicts, verdict);
      annotated.push({ trace: raw, accepted: verdict === 'direct_answer' || verdict === 'appropriate_gap' });
    }
    if (reasons.length) {
      for (const reason of reasons) count(signals, reason);
      queue.push({ traceId: t.id, reasons });
    }
  }
  const feedback = reviewCosts(voted);
  return { teamsTurns: turns.length, sent, deliveryUnconfirmedOrFailed: turns.length - sent,
    repeatRequests, signals, queue, humanVerdicts: scores === null ? null : humanVerdicts,
    humanReviewCosts: scores === null ? null : reviewCosts(annotated),
    feedback: scores === null ? null : { ...feedback, rejected: feedback.reviewed - feedback.accepted } };
}
