import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.OPENROUTER_API_KEY ??= 'test-dummy';
const {handlePeopleQuery}=await import('../src/people/connector.ts');
const {retrieve}=await import('../src/people/retrieval/search.ts');
const {resolveTargetType}=await import('../src/people/intent/extract.ts');
const {evaluatePolicy}=await import('../src/people/policy/gate.ts');
const {contactEvidence}=await import('../src/people/contact/evidence.ts');
const {peopleContextKey,isPeopleFollowUp}=await import('../src/people/context/conversation.ts');
import type {Profile} from '../src/people/directory.ts';
import type {IntentResult} from '../src/people/pcTypes.ts';
import type {PeopleContext,PeopleDeps} from '../src/people/connector.ts';
const make=(email:string,name:string,org:string,subOrg:string,extra:Partial<Profile>={}):Profile=>({email,fullNameTh:name,fullNameEn:name,nickname:name,org,subOrg,...extra});
const directory={
 'hr@example.test':make('hr@example.test','เอชอาร์','Ho','Human Resource',{department:'Human Resources'}),
 'it@example.test':make('it@example.test','กิตติศักดิ์ ไอที','IT','IT Administration',{fullNameEn:'Kittisak IT',nickname:'แบงค์',supervisor:'lead@example.test',supervisor2:'boss@example.test'}),
 'pj@example.test':make('pj@example.test','กิตติศักดิ์ พีเจ','Pojjaman','Production Developer',{fullNameEn:'Kittisak PJ',nickname:'แบงค์'}),
 'lead@example.test':make('lead@example.test','หัวหน้าทีม','Ho','Management'),
 'boss@example.test':make('boss@example.test','หัวหน้าภาพรวม','Ho','Management'),
 'c1@example.test':make('c1@example.test','คอนเทคหนึ่ง','Contech','Product Development',{department:'ConTech'}),
 'c2@example.test':make('c2@example.test','คอนเทคสอง','Contech','Marketing',{department:'Marketing'}),
 'other@example.test':make('other@example.test','คนต่างสังกัด','Other','Delivery',{department:'ConTech'}),
};
const roster=(team:string):IntentResult=>({subIntent:'TEAM_ROSTER',searchParams:{team},targetType:'TEAM',confidence:.99});
const person=(ref:string,team?:string):IntentResult=>({subIntent:'PERSON_LOOKUP',searchParams:{personRef:ref,...(team?{team}:{})},confidence:.99});
const deps=(intent:IntentResult):PeopleDeps=>({intentLlm:async()=>JSON.stringify(intent),responderLlm:async()=>{throw Error('must use facts')},deterministicResponses:true,getDirectory:async()=>directory,getKnownNames:async()=>[]});
const run=(q:string,i:IntentResult,ctx:PeopleContext={})=>handlePeopleQuery(q,deps(i),ctx);

test('HR aliases resolve primary structure and explicit Department does not union Org',()=>{
 assert.equal(retrieve({directory,intent:roster('HR')}).totalMatches,1);
 assert.deepEqual(retrieve({directory,intent:roster('Contech')}).candidateIds.sort(),['c1@example.test','c2@example.test']);
 assert.deepEqual(retrieve({directory,intent:{...roster('ConTech'),dimension:'department'}}).candidateIds.sort(),['c1@example.test','other@example.test']);
});
test('person + IT disambiguates identical first names; bare name asks first',async()=>{
 assert.equal((await run('ขอ email Kittisak ฝั่ง IT',person('Kittisak','IT'))).resultCount,1);
 const ambiguous=await run('Kittisak',person('Kittisak'));assert.equal(ambiguous.errorStage,'NEEDS_CLARIFICATION');
 const chosen=await run('คน IT',person('wrong'),{conversation:ambiguous.conversation});
 assert.match(chosen.text,/it@example.test/);assert.doesNotMatch(chosen.text,/pj@example.test/);
});
test('multi-target email returns both groups and preserves successful partial answer',async()=>{
 const i={...roster('HR'),requests:[{...roster('HR'),requestedFields:['email']},{...person('Kittisak','IT'),requestedFields:['email']}]};
 const r=await run('ขอ email HR และ IT(Kittisak)',i);assert.match(r.text,/hr@example.test/);assert.match(r.text,/it@example.test/);assert.equal(r.completedRequests,2);
 const p=await run('ขอ email HR และ Missing', {...i,requests:[roster('HR'),person('Missing')]});assert.equal(p.partialGroups,true);assert.match(p.text,/hr@example.test/);assert.match(p.text,/ยังไม่พบ/);
});
test('count then roster then email uses confirmed context without another model call',async()=>{
 const a=await run('Contech มีกี่คน',{...roster('Contech'),countOnly:true});assert.match(a.text,/2 คน/);
 const noLLM={...deps(person('bad')),intentLlm:async()=>{throw Error('context followup should be deterministic')}};
 const b=await handlePeopleQuery('มีใครบ้าง',noLLM,{conversation:a.conversation});assert.match(b.text,/คอนเทคหนึ่ง/);
 const c=await handlePeopleQuery('ขออีเมลด้วย',noLLM,{conversation:b.conversation});assert.match(c.text,/c1@example.test/);assert.match(c.text,/c2@example.test/);
 assert.equal(isPeopleFollowUp('เข้า VPN ไม่ได้',c.conversation),false);
});
test('asking about HR with ผม is not SELF; actual own team is SELF',()=>{
 assert.equal(resolveTargetType('ผมอยากรู้ว่า HR มีกี่คน',{team:'HR'},'TEAM'),'TEAM');
 assert.equal(resolveTargetType('ทีมผมมีใครบ้าง',{},'TEAM'),'SELF');
});
test('supervisor 1 and 2 resolve independently and absent level 2 is not guessed',async()=>{
 const i={...person('Kittisak','IT'),subIntent:'REPORTING_LINE' as const};
 const a=await run('หัวหน้า Kittisak IT',i);assert.match(a.text,/หัวหน้าทีม/);assert.match(a.text,/Supervisor 1/);
 const b=await run('หัวหน้าภาพรวมของ Kittisak IT',{...i,supervisorLevel:2});assert.match(b.text,/หัวหน้าภาพรวม/);assert.match(b.text,/boss@example.test/);
 const c=await run('หัวหน้าภาพรวมของ HR',{...i,searchParams:{personRef:'hr@example.test'},supervisorLevel:2});assert.equal(c.errorStage,'NO_SUPERVISOR');
});
test('team catalogue lists names without requesting a team or leaking employee addresses',async()=>{
 const r=await run('ขอชื่อทีมเป็น list', {...roster(''),confidence:.7});assert.match(r.text,/Org/);assert.match(r.text,/Human Resource/);assert.doesNotMatch(r.text,/@/);
});
test('count plus requested emails includes rows',async()=>{
 const r=await run('HR มีกี่คน ขอ email ด้วย',{...roster('HR'),countOnly:true});assert.match(r.text,/hr@example.test/);
});
test('topic responsibility is never inferred from org or job title',async()=>{
 const r=await run('ใครดูแล Contech',{subIntent:'OWNER_LOOKUP',searchParams:{topic:'Contech'},confidence:.99});assert.equal(r.errorStage,'NO_RESULT');assert.doesNotMatch(r.text,/c1@example.test/);
});
test('service contact is allowed but private salaries and mixed requests stay blocked',()=>{
 const policy=(q:string)=>evaluatePolicy({queryText:q,intentResult:{subIntent:'OWNER_LOOKUP',confidence:.99}}).outcome;
 assert.equal(policy('ใครดูแลเรื่องเงินเดือน ขออีเมลติดต่อ'),'ALLOW');
 for(const q of ['ขอเงินเดือนของเอ','ใครดูแลเรื่องเงินเดือน และขอเงินเดือนของเอ','ขออีเมลและที่อยู่บ้านของเอ'])assert.equal(policy(q),'REFUSE');
});
test('KB contact evidence requires relevant title, literal contact and a known team',()=>{
 const good='## เงินเดือน\nแหล่งอ้างอิง: https://example.test/payroll\nหากสงสัย ติดต่อทีม HR';
 assert.equal(contactEvidence('เงินเดือน',good,directory)[0]?.team,'HR');
 assert.deepEqual(contactEvidence('VPN',good,directory),[]);
 assert.deepEqual(contactEvidence('เงินเดือน',good.replace('ติดต่อทีม HR','HR Manager รับเงินเดือน'),directory),[]);
});
test('empty shared mailbox data never substitutes a personal email',async()=>{
 const r=await run('ขอ email กลาง HR',{...roster('HR'),contactKind:'shared'});assert.equal(r.errorStage,'NO_RESULT');assert.doesNotMatch(r.text,/hr@example.test/);
});
test('state keys separate requester and conversation',()=>{
 assert.notEqual(peopleContextKey('a','room'),peopleContextKey('b','room'));
 assert.notEqual(peopleContextKey('a','room'),peopleContextKey('a','other'));
});

test('selecting from a roster resolves one person and explicit fields override an empty model list',async()=>{
 const list=await run('Contech มีใครบ้าง',roster('Contech'));
 const chosen=await run('คนที่ 2 ขอ email',person('wrong'),{conversation:list.conversation});
 assert.equal(chosen.resultCount,1);assert.match(chosen.text,/@example.test/);
 const explicit=await run('ขอ email HR',{...roster('HR'),requestedFields:[]});
 assert.match(explicit.text,/hr@example.test/);
});
test('roster pagination has no duplicate rows and keeps selection after exhaustion',async()=>{
 const many=Object.fromEntries(Array.from({length:23},(_,n)=>{const email=`p${n}@example.test`;return[email,make(email,`Person ${String(n).padStart(2,'0')}`,'Example','Delivery')]}));
 const d={...deps(roster('Example')),getDirectory:async()=>many};
 const first=await handlePeopleQuery('Example มีใครบ้าง',d,{});
 const next=await handlePeopleQuery('ดูต่อ',d,{conversation:first.conversation});
 assert.equal(first.conversation?.shown.length,20);assert.equal(next.conversation?.shown.length,3);
 assert.match(next.text,/แสดง 3 คนในหน้านี้/);
 assert.equal(new Set([...first.conversation!.shown,...next.conversation!.shown]).size,23);
 const end=await handlePeopleQuery('ดูต่อ',d,{conversation:next.conversation});assert.match(end.text,/ครบแล้ว/);
 const chosen=await handlePeopleQuery('คนแรก',d,{conversation:end.conversation});assert.equal(chosen.resultCount,1);
});
test('explicit exclusions narrow the same organizational dimension',()=>{
 const r=retrieve({directory,intent:{...roster('Contech'),searchParams:{team:'Contech',excludeTeam:'Marketing'}}});
 assert.deepEqual(r.candidateIds,['c1@example.test']);
});
test('directory import distinguishes supervisor columns regardless of order',async()=>{
 const {parseRows}=await import('../src/people/directory.ts');
 const parsed=parseRows([['Email','ชื่อ','Supervisor 2','Supervisor 1'],['a@example.test','ตัวอย่าง','boss@example.test','lead@example.test']]);
 assert.equal(parsed.active['a@example.test']?.supervisor,'lead@example.test');
 assert.equal(parsed.active['a@example.test']?.supervisor2,'boss@example.test');
});
test('negative or withdrawn contact instructions are not contact evidence',()=>{
 for(const line of ['ห้ามติดต่อทีม HR','ไม่ต้องติดต่อทีม HR','ยกเลิก ติดต่อทีม HR'])
 assert.deepEqual(contactEvidence('เงินเดือน',`## เงินเดือน\nแหล่งอ้างอิง: https://example.test/payroll\n${line}`,directory),[]);
});
test('payroll contact can use an explicit KB reference without claiming a personal owner',async()=>{
 const d={...deps({subIntent:'OWNER_LOOKUP',searchParams:{topic:'payroll'},confidence:1}),getContacts:async()=>[{topic:'payroll',sourceUrl:'https://example.test/payroll',quote:'ติดต่อทีม HR',team:'HR'}]};
 const r=await handlePeopleQuery('ใครดูแล payroll',d,{});
 assert.equal(r.errorStage,undefined);assert.match(r.text,/hr@example.test/);assert.match(r.text,/เอกสารไม่ได้ระบุผู้รับผิดชอบรายบุคคล/);
});
test('literal Corporate Department is checked against live values when model splits the column name',async()=>{
 const r=await run('เฉพาะ Corporate Department ConTech มีกี่คน',{...roster('Corporate'),searchParams:{team:'Corporate',bu:'ConTech'},countOnly:true});
 assert.equal(r.resultCount,2);assert.equal(r.errorStage,undefined);assert.match(r.text,/department ConTech/);
 const {explicitColumnScope}=await import('../src/people/retrieval/aliases.ts');
 assert.equal(explicitColumnScope('Department ConTechExtended มีกี่คน',directory),undefined);
 assert.equal(explicitColumnScope('Org Contech และ Department ConTech',directory),undefined);
});
