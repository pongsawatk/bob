import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Profile } from '../src/people/directory.ts';
import type { PeopleContext, PeopleDeps } from '../src/people/connector.ts';
import type { IntentResult } from '../src/people/pcTypes.ts';
process.env.OPENROUTER_API_KEY ??= 'test-dummy';
const {handlePeopleQuery} = await import('../src/people/connector.ts');
const directory = Object.fromEntries(Array.from({length:23}, (_,i) => {
  const email = 'example' + i + '@example.test';
  const profile: Profile = {email, fullNameTh:'คนทดสอบ '+String(i).padStart(2,'0'), nickname:'ตัวอย่าง'+i,
    org:'Example', department:'Testing', team:'Demo', position:i<20?'Sales Executive':undefined,
    startDate:String(2024-i)+'-03-01'};
  return [email,profile];
}));
const self: IntentResult={subIntent:'TENURE',searchParams:{},targetType:'SELF',confidence:.99};
const roster: IntentResult={subIntent:'TEAM_ROSTER',searchParams:{team:'Example'},requestedFields:['position'],targetType:'TEAM',confidence:.99};
const run=(q:string,i:IntentResult,ctx:PeopleContext={})=> {
  const deps:PeopleDeps={intentLlm:async()=>JSON.stringify(i),responderLlm:async()=>{throw Error('structured answers must use registry')},
    getDirectory:async()=>directory,getKnownNames:async()=>[],deterministicResponses:true};
  return handlePeopleQuery(q,deps,ctx);
};
test('self tenure, mixed language fields, and confirmed actor identity',async()=>{
  const ctx={requester:{email:'example0@example.test'}};
  for (const q of ['ฉันอายุงานเท่าไหร่','กูอายุงานเท่าไหร่']) assert.equal((await run(q,self,ctx)).identityOutcome,'SELF_RESOLVED');
  const dept=await run('ฉันอยู่ Corporate Department ไหนนะ',{...roster,searchParams:{team:'Corporate Department'}},ctx);
  assert.equal(dept.identityOutcome,'SELF_RESOLVED');assert.match(dept.text,/Department: Testing/);
  const team=await run('ฉันอยู่ Function team อะไร',{...roster,searchParams:{team:'Function team'}},ctx);
  assert.match(team.text,/Function \/ Team: Demo/);
  assert.equal((await run('รู้ไหมว่าผมคือใคร',{...self,subIntent:'PERSON_LOOKUP'},{})).errorStage,'IDENTITY');
  const named=await run('ผมอยากรู้ว่าตัวอย่าง5อายุงานเท่าไร',{...self,searchParams:{personRef:'ตัวอย่าง5'}},ctx);
  assert.deepEqual(named.matchedEmails,['example5@example.test']);
});
test('unsupported age and employment fields do not return substitute facts',async()=>{
  const age=await run('ตัวอย่าง5 อายุเท่าไหร่',{...self,searchParams:{personRef:'ตัวอย่าง5'}});
  assert.equal(age.errorStage,'POLICY_REFUSE');assert.doesNotMatch(age.text,/อายุงาน \(ปี\)/);
  const status=await run('ลาออกหรือยัง',{...self,requestedFields:['startDate']});
  assert.equal(status.errorStage,'NO_RESULT');assert.doesNotMatch(status.text,/วันเริ่มงาน/);
});
test('count by title includes all rows and missing titles without listing people',async()=>{
  const r=await run('ทีม Example ขอแค่จำนวนคนต่อตำแหน่ง ไม่ต้องส่งรายชื่อมา',roster);
  assert.match(r.text,/23 คน/);assert.match(r.text,/Sales Executive: 20 คน/);assert.match(r.text,/ไม่ระบุตำแหน่ง: 3 คน/);
  assert.doesNotMatch(r.text,/คนทดสอบ|example.test/);assert.deepEqual(r.matchedEmails,[]);
});
test('follow-up tenure sorting precedes paging and retains fields on next page',async()=>{
  const list=await run('ขอรายชื่อทีม Example พร้อมตำแหน่งและอายุงาน',roster);
  const sorted=await run('เรียงจากอายุงานเยอะจนถึงน้อยสุด',roster,{conversation:list.conversation});
  assert.equal(sorted.matchedEmails?.[0],'example22@example.test');assert.match(sorted.text,/ตำแหน่ง:/);
  const next=await run('ดูต่อ',roster,{conversation:sorted.conversation});
  assert.equal(next.matchedEmails?.length,3);assert.equal(new Set([...sorted.matchedEmails!,...next.matchedEmails!]).size,23);
});
test('sales synonyms and senior qualifier respect real team scope',async()=>{
  const sales=await run('เซลส์ Example มีใครบ้าง',{...roster,searchParams:{team:'Example',role:'เซลส์'}});
  assert.equal(sales.resultCount,20);
  const senior=await run('Senior sale Example',{...roster,searchParams:{team:'Example',role:'Senior sale'}});
  assert.equal(senior.resultCount,0);assert.match(senior.text,/พบทีม Example/);assert.match(senior.text,/Senior sale/i);
});
test('next page of named matches uses the same offset as team paging',async()=>{
  const named={...self,subIntent:'PERSON_LOOKUP' as const,searchParams:{personRef:'ตัวอย่าง1'}};
  const first=await run('ขอชื่อ ตัวอย่าง1',named);
  const next=await run('ดูต่อ',named,{conversation:first.conversation});
  assert.equal(first.matchedEmails?.length,3);assert.equal(next.matchedEmails?.length,3);
  assert.equal(new Set([...first.matchedEmails!,...next.matchedEmails!]).size,6);
});
test('unavailable requested fields report partial and bare tenure asks whose',async()=>{
  const missing=await run('ตำแหน่ง ตัวอย่าง22',{...self,subIntent:'PERSON_LOOKUP',searchParams:{personRef:'ตัวอย่าง22'}});
  assert.equal(missing.partialGroups,true);assert.match(missing.text,/ตำแหน่ง: ยังไม่มีข้อมูล/);
  const bare=await run('อายุงาน',{...self,targetType:'UNKNOWN'});assert.equal(bare.errorStage,'NEEDS_CLARIFICATION');
});
