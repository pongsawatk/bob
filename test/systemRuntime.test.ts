import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchRetry } from '../src/http/fetchRetry.ts';
import { withBudget, BudgetExceededError, requestBudget } from '../src/http/budget.ts';
import type { LFTrace } from '../src/obs/langfuse.ts';
import type { RouterResult } from '../src/pipeline/router.ts';
process.env.OPENROUTER_API_KEY ??= 'test-dummy';
const { runBoundedPipeline } = await import('../src/pipeline/index.ts');
const { deliverAnswer, DeliveryError } = await import('../src/pipeline/delivery.ts');
const { domainOutcome, peopleOutcome } = await import('../src/pipeline/outcome.ts');

const route: RouterResult = { category: 'HR', confidence: .9, needsClarification: false, model: 'fixture', promptVersion: 'fixture', latencyMs: 1, promptMs: 0, costUsd: 0, rawJson: '{}', usage: { inputTokens: 2, outputTokens: 3 } };
function recorder() {
  const updates: Array<Parameters<LFTrace['update']>[0]> = [];
  const spans: Array<{ name: string; output: unknown }> = [];
  const trace: LFTrace = { traceId: 'fixture-trace', update: o => updates.push(o), generation: () => {}, span: name => ({ end: output => { spans.push({ name, output }); } }) };
  return { trace, updates, spans };
}
test('HTTP timeout covers a stalled response BODY and never retries it', async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); res.write('{'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const start = Date.now();
  try {
    await assert.rejects(fetchRetry(`http://127.0.0.1:${address.port}`, {}, { timeoutMs: 150, retries: 2, backoffMs: 0 }), { name: 'AbortError' });
    assert.equal(requests, 1);
    assert.ok(Date.now() - start < 2000);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test('transient HTTP retries work, while caller cancellation is respected', async () => {
  let requests = 0;
  const server = createServer((_req, res) => { res.writeHead(++requests < 3 ? 429 : 200); res.end('{"ok":true}'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address(); assert.ok(a && typeof a !== 'string');
  try {
    const url = `http://127.0.0.1:${a.port}`;
    assert.deepEqual(await (await fetchRetry(url, {}, { backoffMs: 0 })).json(), { ok: true });
    assert.equal(requests, 3);
    await assert.rejects(fetchRetry(url, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(requests, 3);
    await assert.rejects(fetchRetry(url, {}, { budgetMs: 0 }), BudgetExceededError);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
test('shared budget expires across phases and is isolated between concurrent requests', async () => {
  const result = await Promise.allSettled([
    withBudget(60, async () => { await new Promise(r => setTimeout(r, 30)); return withBudget(200, () => new Promise(r => setTimeout(r, 100))); }),
    withBudget(300, async () => { await new Promise(r => setTimeout(r, 100)); assert.equal(requestBudget()?.signal.aborted, false); return 'ok'; }),
  ]);
  assert.equal(result[0]?.status, 'rejected'); assert.deepEqual(result[1], { status: 'fulfilled', value: 'ok' });
});
test('pipeline asks Timesheet clarification before the answering model', async () => {
  const r = recorder(); let calls = 0;
  const output = await runBoundedPipeline({ message: 'แก้ไทม์ชีทยังไง', userId: 'eval' }, r.trace, {
    route: async () => ({ ...route }), domain: async () => { calls++; throw new Error('must not answer'); },
  });
  assert.match(output.answer, /Pojjaman/); assert.match(output.answer, /HumanSoft/);
  assert.equal(calls, 0); assert.equal(r.updates.at(-1)?.metadata?.answerStatus, 'clarification');
});
test('pipeline timeout returns a nonblank error and suppresses late successful updates', async () => {
  const r = recorder(); let calls = 0;
  const output = await runBoundedPipeline({ message: 'ถามระบบอื่น', userId: 'eval', deadlineMs: Date.now() + 40 }, r.trace, {
    route: async () => { await new Promise(r => setTimeout(r, 100)); return { ...route }; },
    domain: async () => { calls++; throw new Error('cancelled request'); },
  });
  assert.ok(output.answer); assert.equal(r.updates.at(-1)?.metadata?.errorStage, 'TIMEOUT');
  await new Promise(r => setTimeout(r, 130));
  assert.equal(r.updates.length, 1);
  assert.equal(calls, 0);
});
test('delivery records sent, failed, and unknown without retrying', async () => {
  const r = recorder(); let sends = 0;
  await deliverAnswer(r.trace, async () => { sends++; });
  await assert.rejects(deliverAnswer(r.trace, async () => { sends++; throw new Error('offline'); }), DeliveryError);
  await assert.rejects(deliverAnswer(r.trace, async () => { sends++; await new Promise(r => setTimeout(r, 80)); }, 30), (e: unknown) => e instanceof DeliveryError && e.status === 'unknown');
  assert.equal(sends, 3);
  assert.deepEqual(r.spans.map(s => (s.output as { deliveryStatus: string }).deliveryStatus), ['sent', 'failed', 'unknown']);
});
test('outcome labels distinguish operational states and label free-text heuristics', () => {
  assert.equal(peopleOutcome({ partialGroups: true }).answerStatus, 'partial');
  assert.equal(peopleOutcome({ errorStage: 'POLICY_REFUSE' }).answerStatus, 'refused');
  assert.equal(peopleOutcome({ errorStage: 'NEEDS_CLARIFICATION' }).answerStatus, 'clarification');
  assert.equal(domainOutcome('ยังไม่มีข้อมูลใน KB', 'HR').outcomeSource, 'text_heuristic');
  assert.equal(domainOutcome('', 'HR').answerStatus, 'failed');
});
