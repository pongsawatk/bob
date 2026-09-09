import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENROUTER_API_KEY ??= 'test-dummy';
const { retrieve } = await import('../src/people/retrieval/search.ts');
const { handlePeopleQuery } = await import('../src/people/connector.ts');
const { validateIntentResult } = await import('../src/people/pcTypes.ts');
import type { IntentResult } from '../src/people/pcTypes.ts';
const directory = Object.fromEntries([
  { email: 'a@example.test', fullNameTh: 'สมชาย ทดสอบ', nickname: 'เอก', org: 'Pojjaman', team: 'Dev', position: 'Developer' },
  { email: 'b@example.test', fullNameTh: 'สมศรี ทดสอบ', nickname: 'เอก', org: 'Pojjaman', team: 'Business' },
  { email: 'c@example.test', fullNameTh: 'สมใจ ทดสอบ', org: 'Other', team: 'Dev', position: 'Developer' },
].map(p => [p.email, p]));
const intent: IntentResult = { subIntent: 'TEAM_ROSTER', confidence: .95, searchParams: { bu: 'Pojjaman' }, countOnly: true, countGroups: [{ label: 'Dev', team: 'Dev' }, { label: 'Business', team: 'Business' }] };
test('group counts remain scoped to parent BU, deterministic answer covers every group', async () => {
  const r = retrieve({ intent, directory });
  assert.equal(r.totalMatches, 2);
  assert.deepEqual(r.countGroups?.map(g => g.count), [1, 1]);
  assert.deepEqual(r.results, []);
  const answer = await handlePeopleQuery('ทีม Pojjaman รวมกี่คน แยก Dev และ Business', {
    intentLlm: async () => JSON.stringify(intent), responderLlm: async () => { throw new Error('counts must bypass LLM'); },
    getDirectory: async () => directory, getKnownNames: async () => [],
  });
  assert.match(answer.text, /Dev.*1/);
  assert.match(answer.text, /Business.*1/);
  assert.equal(answer.resultCount, 2);
  assert.equal(answer.partialGroups, false);
});
test('unresolved subgroup is explicit partial, never an invented zero', () => {
  const r = retrieve({ intent: { ...intent, countGroups: [{ label: 'Unknown', team: 'Missing' }] }, directory });
  assert.equal(r.totalMatches, 2);
  assert.equal(r.countGroups?.[0]?.count, null);
});
test('Business team count does not count a Business Analyst in the Dev team', () => {
  const directory2 = { ...directory, 'ba@example.test': { email: 'ba@example.test', fullNameTh: 'ทดสอบสี่', org: 'Pojjaman', team: 'Dev', position: 'Business Analyst' } };
  const r = retrieve({ intent, directory: directory2 });
  assert.equal(r.totalMatches, 3);
  assert.deepEqual(r.countGroups?.map(g => g.count), [2, 1]);
});
test('ambiguous person and supervisor require confirmation; exact email resolves', () => {
  for (const subIntent of ['PERSON_LOOKUP', 'REPORTING_LINE'] as const) {
    const r = retrieve({ intent: { subIntent, confidence: .9, searchParams: { personRef: 'เอก' } }, directory });
    assert.equal(r.needsClarification, true);
    assert.deepEqual(r.results, []);
    assert.ok(!JSON.stringify(r.clarifyOptions).includes('@'));
  }
  const r = retrieve({ intent: { subIntent: 'PERSON_LOOKUP', confidence: .9, searchParams: { personRef: 'a@example.test' } }, directory });
  assert.equal(r.results[0]?.profile.email, 'a@example.test');
});
test('name typo produces suggestions only, never a guessed profile', () => {
  const r = retrieve({ intent: { subIntent: 'PERSON_LOOKUP', confidence: .9, searchParams: { personRef: 'สมชาย ทดสอป' } }, directory });
  assert.equal(r.needsClarification, true);
  assert.deepEqual(r.results, []);
  assert.ok(r.clarifyOptions?.includes('สมชาย ทดสอบ'));
});
test('group schema requires count intent and bounded filters; no unscoped enumeration', () => {
  assert.deepEqual(validateIntentResult(intent), []);
  assert.ok(validateIntentResult({ ...intent, countOnly: false }).length);
  assert.ok(validateIntentResult({ ...intent, countGroups: [{ label: 'all' }] }).length);
  assert.ok(validateIntentResult({ ...intent, countGroups: Array(7).fill({ label: 'Dev', team: 'Dev' }) }).length);
  assert.equal(retrieve({ intent: { ...intent, searchParams: {} }, directory }).totalMatches, 0);
});
