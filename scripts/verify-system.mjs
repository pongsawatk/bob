// Controlled live-model acceptance: reads prompts and a local KB snapshot, sends no Teams messages.
// Usage: node --import tsx scripts/verify-system.mjs <kb-private.json>
// Writes private review evidence under ignored test-results/, never to the KB or Langfuse traces.
import { loadEnv } from './_load-env.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
loadEnv();
const { routeMessage } = await import('../src/pipeline/router.ts');
const { decideRoute } = await import('../src/pipeline/routePolicy.ts');
const { callDomainBot } = await import('../src/pipeline/domainBot.ts');
const { handlePeopleQuery, defaultPeopleDeps } = await import('../src/people/connector.ts');
const { withBudget } = await import('../src/http/budget.ts');
const { SYSTEM_POLICY_VERSION } = await import('../src/prompts/systemPolicy.ts');
if (!process.argv[2]) throw new Error('Provide a local KB snapshot path');
const { bundles } = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (typeof bundles?.hr !== 'string' || typeof bundles?.process !== 'string' || typeof bundles?.product !== 'string') throw new Error('Invalid snapshot');
const kb = { getHRBundle: async () => `${bundles.hr}\n\n${bundles.process}`, getProductBundle: async () => bundles.product };
const cases = [
  { id: 'leave', q: 'สวัสดิการวันลา', category: 'HR', source: /วันลา|การลา/ },
  { id: 'timesheet-clarify', q: 'แก้ไขไทมืชีทยังไง', clarification: true },
  { id: 'timesheet-followup', q: 'ขอขั้นตอนแก้ไขและลิงก์', history: [{ role: 'user', content: 'แก้ไขไทม์ชีทยังไง' }, { role: 'assistant', content: 'Pojjaman หรือ HumanSoft ครับ?' }, { role: 'user', content: 'Pojjaman ครับ' }], category: 'HR', source: /Timesheet/i },
  { id: 'product-contact', q: 'ขอเบอร์กลางของโปรแกรม Ploy', category: 'PRODUCT' },
  { id: 'eligibility', q: 'สมัครกองทุนสำรองเลี้ยงชีพได้ไหม และต้องทำอย่างไร', category: 'HR', profile: 'ผู้ถาม: ผู้ทดสอบระบบ; วันเริ่มงาน 2023-01-01; อายุงานมากกว่า 3 ปี; ไม่มีข้อมูลสถานะผ่านทดลองงาน' },
];
const results = []; let costUsd = 0;
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt >= 0 ? process.argv[onlyAt + 1].split(',') : null;
for (const c of cases.filter(c => !only || only.includes(c.id))) {
  const result = await withBudget(45000, async () => {
    const routed = await routeMessage(c.q, c.history ?? []); costUsd += routed.costUsd;
    const decision = decideRoute(routed, c.q, c.history ?? []);
    if (decision.clarification) return { id: c.id, pass: c.clarification === true, category: decision.category, answer: decision.clarification };
    const answer = await callDomainBot(decision.category, c.q, 'คุณ', '', c.history ?? [], c.profile, kb); costUsd += answer.costUsd;
    const selected = answer.kbSelect?.sources?.map(s => s.title) ?? [];
    const pass = decision.category === c.category && (!c.source || selected.some(t => c.source.test(t))) && answer.text.trim().length > 0
      && (c.id !== 'timesheet-followup' || answer.evidenceGap === 'timesheet_edit_workflow')
      && (c.id !== 'leave' || /ลาป่วย/.test(answer.text) && /ลากิจ/.test(answer.text) && /เท่าที่ป่วยจริง|ตามที่ป่วยจริง|ตามจริง|ตามอาการ/.test(answer.text) && !/หมายถึงอะไร|ขอถามให้ชัด|ตีความได้สอง/.test(answer.text));
    return { id: c.id, pass, category: decision.category, promptVersion: answer.promptVersion, selected, answer: answer.text, guarded: answer.eligibilityGuarded, latencyMs: answer.latencyMs };
  });
  results.push(result); console.log(JSON.stringify({ id: result.id, pass: result.pass, category: result.category }));
}
const directory = Object.fromEntries([
  { email: 'dev@example.test', fullNameTh: 'คนทดสอบ หนึ่ง', org: 'Pojjaman', team: 'Dev' },
  { email: 'business@example.test', fullNameTh: 'คนทดสอบ สอง', org: 'Pojjaman', team: 'Business' },
  { email: 'other@example.test', fullNameTh: 'คนทดสอบ สาม', org: 'Other', team: 'Dev' },
].map(p => [p.email, p]));
if (!only || only.includes('people-groups')) {
const peopleDeps = defaultPeopleDeps(g => { costUsd += g.usage.totalCost; });
const people = await withBudget(45000, () => handlePeopleQuery('ทีม Pojjaman รวมกี่คน แยกทีม Dev และ Business อย่างละกี่คน', {
  ...peopleDeps, getDirectory: async () => directory, getKnownNames: async () => [], getMeta: async () => null,
}));
results.push({ id: 'people-groups', pass: people.resultCount === 2 && /Dev.*1/.test(people.text) && /Business.*1/.test(people.text), answer: people.text });
}
await mkdir('test-results', { recursive: true });
const file = `test-results/system-live-${Date.now()}.json`;
await writeFile(file, JSON.stringify({ systemPolicyVersion: SYSTEM_POLICY_VERSION, costUsd, results, note: 'Automated checks cover routing, recall, and structural answers. Human review required for factual correctness.' }, null, 2));
console.log(JSON.stringify({ file, costUsd, passed: results.filter(r => r.pass).length, total: results.length }));
if (results.some(r => !r.pass)) process.exitCode = 1;
