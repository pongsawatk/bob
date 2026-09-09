import { createHmac } from 'node:crypto';
import type { NormalizedTurn } from './langfuse.js';
export type SnapshotTurn = Omit<NormalizedTurn, 'rawUserId'> & { userKey: string };
export const snapshotKeyId = (key: string) => createHmac('sha256', key).update('bob-analytics-v1:key-id').digest('hex').slice(0, 16);
export interface Snapshot { schemaVersion: number; pseudonymKeyId: string; exportedAt: string; turns: SnapshotTurn[] }
/** Overlapping exports are expected. Keep known outcome fields when later exports lack them. */
export function mergeSnapshots(snapshots: Snapshot[]): SnapshotTurn[] {
  if (!snapshots.length) return [];
  const key = snapshots[0]?.pseudonymKeyId;
  if (!key || snapshots.some(s => s.schemaVersion !== 1 || s.pseudonymKeyId !== key || !Array.isArray(s.turns))) throw new Error('Incompatible snapshot schema or pseudonym keys');
  const merged = new Map<string, SnapshotTurn>();
  for (const s of [...snapshots].sort((a, b) => a.exportedAt.localeCompare(b.exportedAt))) {
    for (const t of s.turns) {
      const prev = merged.get(t.id);
      merged.set(t.id, { ...t,
        answerStatus: t.answerStatus && t.answerStatus !== 'unknown' ? t.answerStatus : prev?.answerStatus ?? 'unknown',
        outcomeSource: t.outcomeSource && t.outcomeSource !== 'unknown' ? t.outcomeSource : prev?.outcomeSource ?? 'unknown',
        deliveryStatus: t.deliveryStatus && t.deliveryStatus !== 'not_recorded' ? t.deliveryStatus : prev?.deliveryStatus ?? 'not_recorded',
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.tsMs - b.tsMs);
}
/** Pseudonymous metrics only. No questions, answers, names, source documents, or raw identity. */
export function snapshotTurns(turns: NormalizedTurn[], key: string): SnapshotTurn[] {
  if (!key) throw new Error('Snapshot pseudonym key is required');
  const hash = (type: string, value: string) => createHmac('sha256', key).update(`bob-analytics-v1:${type}:${value}`).digest('hex');
  return turns.map(t => ({
    id: t.id, userKey: hash('user', t.rawUserId), sessionId: hash('session', t.sessionId),
    tsMs: t.tsMs, dayKey: t.dayKey, intent: t.intent, latencyMs: t.latencyMs,
    costUsd: t.costUsd, outputTokens: t.outputTokens, truncated: t.truncated,
    fromCache: t.fromCache, channel: t.channel, hasCategory: t.hasCategory, hasLatency: t.hasLatency,
    answerStatus: t.answerStatus, outcomeSource: t.outcomeSource, deliveryStatus: t.deliveryStatus, reviewRequired: t.reviewRequired,
  }));
}
export function qualityCounts(turns: Pick<NormalizedTurn, 'answerStatus' | 'deliveryStatus'>[]) {
  const answer: Record<string, number> = {}, delivery: Record<string, number> = {};
  for (const t of turns) {
    const a = t.answerStatus ?? 'unknown', d = t.deliveryStatus ?? 'not_recorded';
    answer[a] = (answer[a] ?? 0) + 1; delivery[d] = (delivery[d] ?? 0) + 1;
  }
  return { answer, delivery, note: 'Operational labels; answered does not establish factual correctness. Legacy turns remain unknown.' };
}
