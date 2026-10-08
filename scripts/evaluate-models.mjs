// Paired generation replay. All challengers receive the exact same assembled
// prompt, history and KB as the control. Results remain UNREVIEWED until a human reviews.
import { loadEnv } from './_load-env.mjs';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
loadEnv();
const { values } = parseArgs({ options: { arms: { type: 'string', default: 'sonnet55-medium,gemini38-low,haiku55-low' }, limit: { type: 'string', default: '8' }, 'max-usd': { type: 'string', default: '3' }, 'hr-version': { type: 'string' }, out: { type: 'string', default: 'test-results/model-quality-20261008/replay.jsonl' } } });
if (values['hr-version']) process.env.BOB_PROMPT_VERSION_HR = values['hr-version'];
const { ARMS, isExperimentArm } = await import('../src/llm/modelConfig.ts');
const { withModelExperiment } = await import('../src/llm/experimentContext.ts');
const { callDomainBot } = await import('../src/pipeline/domainBot.ts');
const { callLLM } = await import('../src/llm/openrouter.ts');
const { validateITAnswer } = await import('../src/kb/itAnswer.ts');
const { guardEligibility } = await import('../src/prompts/systemPolicy.ts');
const arms = values.arms.split(',');
if (!arms.every(isExperimentArm)) throw new Error('Unknown arm');
const cases = readFileSync('test-cases/model-quality.jsonl','utf8').trim().split('\n').map(JSON.parse).slice(0,Number(values.limit));
mkdirSync('test-results/model-quality-20261008', { recursive: true });
writeFileSync(values.out, '');
let cost = 0, unknownCost = false;
const budget = Number(values['max-usd']);
if (!Number.isFinite(budget) || budget <= 0 || budget > 10) throw new Error('Invalid test budget');
function record(row) {
  appendFileSync(values.out, JSON.stringify(row)+'\n');
  console.log(JSON.stringify({ id: row.id, arm: row.arm, model: row.actualModel, finishReason: row.finishReason, costUsd: row.costUsd, error: row.error, skipped: row.skipped }));
  if (row.costUsd === null) unknownCost = true;
  else if (typeof row.costUsd === 'number') cost += row.costUsd;
}
for (const tc of cases) {
  if (unknownCost || cost + 1 > budget) break;
  const scope = { arm: 'sonnet5-medium' };
  let control;
  try { control = await withModelExperiment(scope, () => callDomainBot(tc.category,tc.question,'Tester','',tc.history ?? [])); }
  catch (e) { record({ id:tc.id, arm:'sonnet5-medium', error:String(e), costUsd:null }); break; }
  const snapshot = scope.snapshot;
  record({ ...tc, arm:'sonnet5-medium', ...control, ...(snapshot ? { promptHash:snapshot.promptHash, kbHash:snapshot.kbHash, sourceClock:snapshot.createdAt, evidence:snapshot.selection.bundle } : {}), qualityStatus:'UNREVIEWED' });
  if (!snapshot) { record({ id:tc.id, skipped:'deterministic response; no answering model needed' }); continue; }
  for (const arm of arms) {
    if (unknownCost || cost + 1 > budget) break;
    try {
      const r = await callLLM({ ...snapshot.options, ...ARMS[arm], cacheSystem:false, strictProvider:true, maxPrice:{prompt:4,completion:10}, retries:0, timeoutMs:40000 });
      const checked = tc.category === 'IT' ? validateITAnswer(r.text,snapshot.selection) : guardEligibility(r.text);
      record({ ...tc, arm, ...r, rawAnswer:r.text, text:checked.text, guarded:checked.guarded, promptHash:snapshot.promptHash, kbHash:snapshot.kbHash, sourceClock:snapshot.createdAt, qualityStatus:'UNREVIEWED' });
    } catch(e) { record({ id:tc.id, arm, error:String(e), costUsd:null }); break; }
  }
}
console.log(JSON.stringify({ billedUsd:cost, unknownCost, out:values.out }));
if (unknownCost) process.exitCode=2;
