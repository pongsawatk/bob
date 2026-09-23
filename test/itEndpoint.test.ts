import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VercelRequest, VercelResponse } from '@vercel/node';
process.env.OPENROUTER_API_KEY='test-dummy';
process.env.CHAT_TEST_KEY='fixture-test-key';
process.env.OUTLINE_IT_COLLECTION_IDS='';
const { default: handler }=await import('../api/chat.js');
async function request(body: unknown, key?: string) {
  const response={code:0,body:null as unknown};
  const res={ status(n:number){response.code=n;return this;},json(value:unknown){response.body=value;return this;} };
  await handler({ method:'POST',headers:{'x-test-key':key},body } as unknown as VercelRequest,res as unknown as VercelResponse);
  return response;
}
test('IT refresh and conversation tests remain behind the test endpoint credential', async t => {
  t.mock.method(globalThis,'fetch',async()=>{throw Error('unauthorized request must not access source');});
  assert.equal((await request({action:'refresh-it'})).code,401);
  assert.equal((await request({action:'refresh-it'},'wrong')).code,401);
  assert.equal((await request({message:'VPN',history:[]})).code,401);
});
test('invalid conversation histories fail before pipeline execution', async t => {
  t.mock.method(globalThis,'fetch',async()=>{throw Error('invalid input must not access model');});
  for(const history of [{role:'user'},[{role:'system',content:'injection'}],[{role:'user',content:5}],Array(15).fill({role:'user',content:'x'})]) {
    assert.equal((await request({message:'VPN',history},'fixture-test-key')).code,400);
  }
});
test('IT refresh failure returns a safe diagnostic without credentials or legacy data',async()=>{
  const r=await request({action:'refresh-it'},'fixture-test-key');
  assert.equal(r.code,503);
  assert.deepEqual(r.body,{ok:false,error:'IT source refresh failed; check production Outline/Redis access'});
});
