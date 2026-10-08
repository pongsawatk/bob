import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENROUTER_API_KEY ??= 'fixture';
const { buildLLMBody, callLLM } = await import('../src/llm/openrouter.js');
const { renderPrompt } = await import('../src/prompts/render.js');
const { ARMS, modelSettings } = await import('../src/llm/modelConfig.js');
const { withModelExperiment, callDomainLLM } = await import('../src/llm/experimentContext.js');
const { DEFAULT_EVALUATION_CONFIG, validateConfig, pilotArm, sampled } = await import('../src/evaluation/config.js');
const { reviewWithJev, redactReviewText } = await import('../src/evaluation/jev.js');
const { selectDocs } = await import('../src/kb/select.js');
const { appendHistory, getHistory, clearHistory, historyEpoch } = await import('../src/channels/history.js');
const { withConversationTurn } = await import('../src/channels/turns.js');

for (const [arm, config] of Object.entries(ARMS)) test(`${arm}: compatible effort, strict parameters, no custom temperature`, () => {
  const b = buildLLMBody({ ...config, systemPrompt: 'policy', messages: [], temperature: .3, cacheSystem: true });
  assert.equal('temperature' in b, false);
  assert.equal(b.reasoning?.effort, config.effort);
  assert.equal(b.provider?.require_parameters, true);
  if (arm === 'gemini38-low') assert.equal(typeof b.messages[0]?.content, 'string');
});
test('literal prompt assembly preserves dollar sequences and embedded placeholder text', () => {
  assert.equal(renderPrompt('{{KB_BUNDLE}} / {{CURRENT_DATE}}', { KB_BUNDLE: "$& $$ $' {{CURRENT_DATE}}", CURRENT_DATE: 'today' }), "$& $$ $' {{CURRENT_DATE}} / today");
});
test('LLM records actual model/provider/finish reason and unknown billing', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'id', model: 'actual', provider: 'fixture', choices: [{ finish_reason: 'length', message: { content: 'partial' } }], usage: { completion_tokens_details: { reasoning_tokens: 17 } } }));
  const r = await callLLM({ model: ARMS['sonnet55-medium'].model, effort: 'medium', systemPrompt: 'x', messages: [] });
  assert.equal(r.costUsd, null); assert.equal(r.actualModel, 'actual'); assert.equal(r.finishReason, 'length');
  assert.equal(r.usage.reasoningTokens, 17); assert.equal(r.effectiveEffort, 'unknown');
});
test('experiment capture freezes the exact prompt and independent request scopes', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, opts) => { const body = JSON.parse(String(opts?.body)); return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { cost: .01 } }); });
  const scopes: import('../src/llm/experimentContext.js').ModelExperimentContext[] = [{ arm: 'haiku55-low' }, { arm: 'sonnet55-medium' }];
  await Promise.all(scopes.map(s => withModelExperiment(s, () => callDomainLLM('HR', { ...modelSettings('HR'), systemPrompt: 'fixed-clock KB', messages: [] }, 'v7', selectDocs('x', 'evidence')))));
  assert.equal(scopes[0]?.snapshot?.result.requestedModel, ARMS['haiku55-low'].model);
  assert.equal(scopes[1]?.snapshot?.result.requestedModel, ARMS['sonnet55-medium'].model);
  assert.equal(scopes[0]?.snapshot?.promptHash, scopes[1]?.snapshot?.promptHash);
});
test('pilot requires allowlisted identity; sampling and budget settings reject bad inputs', () => {
  const c = { ...DEFAULT_EVALUATION_CONFIG, mode: 'pilot' as const, pilotUsers: ['tester@example.test'] };
  assert.equal(pilotArm(c, ' Tester@Example.Test '), 'sonnet55-medium');
  assert.equal(pilotArm(c, 'someone@example.test'), undefined);
  assert.equal(validateConfig({ ...c, arm: '__proto__' }), false);
  assert.equal(validateConfig({ ...c, dailyMaxUsd: NaN }), false);
  assert.equal(validateConfig({ ...c, sampleRate: 2 }), false);
  assert.equal(sampled({ ...c, mode: 'off' }, 'trace'), false);
});
test('maternity query retrieves leave chapter and follows annual-leave cross-reference', () => {
  const doc = (title: string, body: string) => `## ${title}\nแหล่งอ้างอิง: https://kb.test/${encodeURIComponent(title)}\n${body}`;
  const b = [doc('หมวด 7 การลา', 'ลาคลอด ลาป่วย ดูหมวด 4 สำหรับพักผ่อน'), doc('หมวด 4 เวลาทำงาน', 'เงื่อนไขพักผ่อนประจำปี'), ...Array.from({length:8},(_,i)=>doc(`กิจกรรม ${i}`, 'กิจกรรม '.repeat(600)))].join('\n\n---\n\n');
  const r = selectDocs('ลาคลอดได้อย่างไร', b);
  assert.match(r.bundle, /หมวด 7/); assert.match(r.bundle, /หมวด 4/); assert.ok(r.chars < b.length);
});
test('Jev skips oversized input, validates typed answers and preserves uncertainty', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ answers: { grounding: { type: 'choice', choice: 'insufficient', confidence: .9 }, completeness: { type: 'choice', choice: 'uncertain' }, relevance: { type: 'choice', choice: 'uncertain' } } }); });
  assert.equal((await reviewWithJev({ question:'x', answer:'y', evidence:'ก'.repeat(10000) })).status, 'not_assessed');
  assert.equal(calls, 0);
  const result = await reviewWithJev({ question:'x', answer:'y', evidence:'z' });
  assert.equal(result.status, 'assessed'); assert.equal(result.answers?.grounding?.choice, 'insufficient'); assert.equal(result.costUsd, null);
});
test('Jev redacts known names, email and phone without using profile blocks', () => {
  const s = redactReviewText('สมชาย ติดต่อ person@example.test 081-234-5678', ['สมชาย']);
  assert.doesNotMatch(s, /สมชาย|person@|081/);
});
test('concurrent history append retains both turns and reset rejects a late answer', async () => {
  const id = 'fixture-quality-history'; await clearHistory(id); const epoch = await historyEpoch(id);
  await Promise.all([appendHistory(id, 'q1', 'a1', epoch), appendHistory(id, 'q2', 'a2', epoch)]);
  assert.equal((await getHistory(id)).length, 4);
  await clearHistory(id); await appendHistory(id, 'old', 'old', epoch);
  assert.deepEqual(await getHistory(id), []);
});
test('conversation serialization sees the completed preceding turn and deduplicates activities', async () => {
  const order: string[] = [];
  await Promise.all([
    withConversationTurn('fixture-lock','1',async()=>{ await new Promise(r=>setTimeout(r,30)); order.push('first'); }),
    withConversationTurn('fixture-lock','2',async()=>{ assert.deepEqual(order,['first']); order.push('second'); }),
  ]);
  assert.equal(await withConversationTurn('fixture-lock','1',async()=>{ throw Error('duplicate'); }), 'duplicate');
});
