import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENROUTER_API_KEY = 'fixture';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
process.env.QSTASH_TOKEN = '';
process.env.CHAT_TEST_KEY = 'fixture-admin';
process.env.CRON_SECRET = '';
const { getRedis } = await import('../src/store/redis.js');
const { processEvaluation, enqueueEvaluation } = await import('../src/evaluation/jobs.js');
const { DEFAULT_EVALUATION_CONFIG } = await import('../src/evaluation/config.js');
const { ARMS } = await import('../src/llm/modelConfig.js');
const { selectDocs } = await import('../src/kb/select.js');
const { default: admin, authorizedEvaluation } = await import('../api/evaluation/index.js');
const { default: worker } = await import('../api/evaluation/worker.js');
const { deliverAnswer } = await import('../src/pipeline/delivery.js');
const CONFIG = 'bob:eval:v1:config';
const jobKey = (id: string) => `bob:eval:v1:job:${id}`;
const snapshot: import('../src/llm/experimentContext.js').EvaluationSnapshot = {
  schema: 1, category: 'HR', promptVersion: 'fixture-v4', configVersion: 'fixture',
  promptHash: 'prompt-hash', kbHash: 'kb-hash', createdAt: '2026-10-08T00:00:00Z',
  options: { ...ARMS['sonnet5-medium'], systemPrompt: 'frozen evidence and clock', messages: [{ role: 'user', content: 'question' }], userContext: 'private profile', maxTokens: 4096 },
  selection: selectDocs('question', 'fixture evidence'),
  result: { text: 'baseline', requestedModel: ARMS['sonnet5-medium'].model, actualModel: ARMS['sonnet5-medium'].model,
    finishReason: 'stop', latencyMs: 10, costUsd: .02, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
};
function fake(t: TestContext) {
  const db = new Map<string, any>([[CONFIG, { ...DEFAULT_EVALUATION_CONFIG, mode: 'shadow' }]]);
  const scripts: Array<{ script: string; keys: string[]; args: unknown[] }> = [];
  const r = getRedis()!;
  let budgetAllowed = true;
  // Stub the HTTP requester, below the SDK's automatic-pipeline proxy.
  t.mock.method((r as any).client, 'request', async (req: { body: unknown[] }) => {
    const commands = Array.isArray(req.body[0]) ? req.body as any[][] : [req.body];
    const results = commands.map(([command, ...args]) => {
      if (command === 'get') return { result: db.has(args[0]) ? JSON.stringify(db.get(args[0])) : null };
      if (command === 'set') {
        if (args.includes('nx') && db.has(args[0])) return { result: null };
        let value = args[1]; try { value = JSON.parse(value); } catch { /* scalar */ }
        db.set(args[0], value); return { result: 'OK' };
      }
      if (command === 'eval') {
        const n = Number(args[1]);
        scripts.push({ script: args[0], keys: args.slice(2, 2 + n), args: args.slice(2 + n) });
        return { result: budgetAllowed ? 1 : 0 };
      }
      if (command === 'zadd' || command === 'zremrangebyscore') return { result: 1 };
      throw new Error(`Unexpected Redis command: ${command}`);
    });
    return Array.isArray(req.body[0]) ? results : results[0];
  });
  return { db, scripts, denyBudget: () => { budgetAllowed = false; } };
}
function res() {
  const r = { statusCode: 200, body: undefined as unknown, setHeader() {}, status(n: number) { this.statusCode = n; return this; }, json(b: unknown) { this.body = b; }, end() {} };
  return r;
}
test('shadow replay preserves the primary and frozen inputs; duplicate worker makes one call', async t => {
  const { db, scripts } = fake(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    calls++;
    const b = JSON.parse(String(opts?.body));
    assert.equal(b.model, ARMS['sonnet55-medium'].model);
    assert.equal(b.messages[0].content, 'frozen evidence and clock\n\nprivate profile');
    assert.equal(b.reasoning.effort, 'medium');
    assert.equal(b.provider.allow_fallbacks, false);
    return Response.json({ model: b.model, choices: [{ finish_reason: 'stop', message: { content: 'candidate' } }], usage: { cost: .03 } });
  });
  const id = await enqueueEvaluation(structuredClone(snapshot), 'fixture-trace', db.get(CONFIG));
  assert.ok(id);
  await Promise.all([processEvaluation(id), processEvaluation(id)]);
  await processEvaluation(id);
  assert.equal(calls, 1);
  const job = db.get(jobKey(id));
  assert.equal(job.status, 'complete'); assert.equal(job.snapshot, undefined);
  assert.equal(job.result.baseline.text, 'baseline'); assert.equal(job.result.candidate.text, 'candidate');
  assert.equal(job.result.comparisonValid, true); assert.equal(job.result.qualityStatus, 'awaiting_human_review');
  assert.equal(job.result.jev.reason, 'disabled');
  assert.notEqual(scripts[0]?.keys[0], scripts[0]?.keys[1]);
  assert.equal(Number(scripts[1]?.args[0]), -.97);
  assert.equal([...db.keys()].some(k => k.startsWith('bob:conv:')), false);
});
test('off switch, budget exhaustion and oversized context never call a provider', async t => {
  const { db, denyBudget } = fake(t);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Provider must not be called'); });
  for (const [reason, mutation] of [
    ['disabled', () => db.set(CONFIG, { ...DEFAULT_EVALUATION_CONFIG })],
    ['context_exceeds_cost_bound', () => { db.set(CONFIG, { ...DEFAULT_EVALUATION_CONFIG, mode: 'shadow' }); }],
    ['budget', denyBudget],
  ] as const) {
    const id = `fixture-${reason}`;
    const s = structuredClone(snapshot);
    if (reason === 'context_exceeds_cost_bound') s.options.systemPrompt = 'x'.repeat(160001);
    db.set(jobKey(id), { id, traceId: id, arm: 'sonnet55-medium', status: 'pending', snapshot: s });
    mutation();
    assert.equal((await processEvaluation(id))?.reason, reason);
  }
});
test('an interrupted running job is not inferred again and keeps its unknown charge', async t => {
  const { db, scripts } = fake(t);
  const id = 'interrupted';
  db.set(jobKey(id), { id, status: 'running', snapshot });
  assert.equal((await processEvaluation(id))?.reason, 'interrupted_billing_unknown');
  assert.equal(scripts.length, 0);
});
test('failed candidate retains reservation and does not retry through another model', async t => {
  const { db, scripts } = fake(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('failure', { status: 503 }); });
  const id = 'failed';
  db.set(jobKey(id), { id, arm: 'sonnet55-medium', status: 'pending', snapshot });
  assert.equal((await processEvaluation(id))?.status, 'failed');
  assert.equal(calls, 1); assert.equal(scripts.length, 1);
});
test('admin secret is required and raw per-user snapshots cannot be fetched', async t => {
  const { db } = fake(t); const id = '00000000-0000-4000-8000-000000000000';
  assert.equal(authorizedEvaluation(['fixture-admin']), false);
  const unauthorized = res();
  await admin({ method: 'POST', headers: {}, body: { action: 'configure' } } as any, unauthorized as any);
  assert.equal(unauthorized.statusCode, 401);
  db.set(jobKey(id), { id, status: 'pending', snapshot });
  const pending = res();
  await admin({ method: 'POST', headers: { 'x-test-key': 'fixture-admin' }, body: { action: 'get', jobId: id } } as any, pending as any);
  assert.equal(pending.statusCode, 404); assert.equal(pending.body, undefined);
});
test('worker rejects unsigned and oversized parsed bodies before accessing jobs', async () => {
  const unsigned = res();
  await worker({ method: 'POST', headers: {}, body: { jobId: 'test' } } as any, unsigned as any);
  assert.equal(unsigned.statusCode, 401);
  const oversized = res();
  await worker({ method: 'POST', headers: {}, body: { jobId: 'x'.repeat(2000) } } as any, oversized as any);
  assert.equal(oversized.statusCode, 413);
});
test('reset cancellation is observable and never counted as a delivered answer', async () => {
  const ended: unknown[] = [];
  const trace = { traceId: 'fixture', update() {}, generation() {}, span: () => ({ end: (v: unknown) => ended.push(v) }) };
  assert.equal(await deliverAnswer(trace, async () => false), false);
  assert.equal((ended[0] as { deliveryStatus: string }).deliveryStatus, 'cancelled');
});
