import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAll, normalizeTrace, observationsToTraces, type RawObservation } from '../src/analytics/langfuse.ts';
import { snapshotTurns, snapshotKeyId, mergeSnapshots, qualityCounts } from '../src/analytics/snapshot.ts';
const trace = { id: 'id1', userId: 'aad-fixture', name: 'bob-chat', timestamp: '2026-09-08T00:00:00Z', metadata: { category: 'HR', channel: 'teams', latencyMs: 3000 } };
test('contract includes AAD users and excludes smoke even with a real-looking email', () => {
  assert.ok(normalizeTrace(trace));
  assert.equal(normalizeTrace({ ...trace, userId: 'user@example.test', metadata: { channel: 'migration-smoke' } }), null);
  assert.equal(normalizeTrace({ ...trace, tags: ['test'] }), null);
  assert.equal(normalizeTrace({ ...trace, timestamp: 'bad' }), null);
  assert.equal(normalizeTrace({ ...trace, metadata: {}, tags: ['HR', 'teams', 'llm'] })?.channel, 'teams');
});
test('observation reconstruction deduplicates cost, joins delivery, and ignores orphan children', () => {
  const root: RawObservation = { id: 'root', traceId: 'id1', name: 'bob-chat', userId: 'aad-fixture', startTime: trace.timestamp, endTime: trace.timestamp, parentObservationId: null, type: 'SPAN', metadata: trace.metadata };
  const gen: RawObservation = { ...root, id: 'gen', parentObservationId: 'root', type: 'GENERATION', totalCost: .2 };
  const delivery: RawObservation = { ...root, id: 'send', parentObservationId: 'root', name: 'delivery', output: '{"deliveryStatus":"sent"}' };
  const rows = observationsToTraces([gen, root, gen, delivery]);
  assert.equal(rows.length, 1); assert.equal(rows[0]?.totalCost, .2);
  assert.equal(normalizeTrace(rows[0]!)?.deliveryStatus, 'sent');
  assert.deepEqual(observationsToTraces([gen]), []);
});
test('snapshot has stable pseudonyms and no raw identities or message bodies', () => {
  const turns = normalizeAll([{ ...trace, userId: 'private@example.test', sessionId: 'private-session', input: 'private question', output: 'private answer' }]);
  const a = snapshotTurns(turns, 'fixture-key'), b = snapshotTurns(turns, 'fixture-key');
  assert.deepEqual(a, b); assert.doesNotMatch(JSON.stringify(a), /private|rawUserId|input|output"/);
  assert.notEqual(a[0]?.userKey, snapshotTurns(turns, 'different-key')[0]?.userKey);
  assert.deepEqual(qualityCounts(turns).answer, { unknown: 1 });
  assert.deepEqual(qualityCounts(turns).delivery, { not_recorded: 1 });
});
test('overlapping archives deduplicate turns and reject key rotation', () => {
  const turns = snapshotTurns(normalizeAll([trace]), 'fixture');
  const old = { schemaVersion: 1, pseudonymKeyId: snapshotKeyId('fixture'), exportedAt: '2026-09-08', turns: turns.map(t => ({ ...t, deliveryStatus: 'sent' })) };
  const newer = { ...old, exportedAt: '2026-09-09', turns };
  assert.equal(mergeSnapshots([old, newer]).length, 1);
  assert.equal(mergeSnapshots([old, newer])[0]?.deliveryStatus, 'sent');
  assert.throws(() => mergeSnapshots([old, { ...newer, pseudonymKeyId: 'different' }]));
});
