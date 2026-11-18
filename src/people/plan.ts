import type { PeopleContext, PeopleDeps, PeopleResult } from './connector.js';
import type { IntentResult } from './pcTypes.js';
import { extractIntent, detectSelfReference } from './intent/extract.js';
import { isPeopleFollowUp, type PeopleConversation } from './context/conversation.js';
import { norm } from './profileStore.js';
import { evaluatePolicy } from './policy/gate.js';
import { explicitColumnScope } from './retrieval/aliases.js';
import { canonicalRole } from './retrieval/roles.js';

export function requestedPeopleFields(query: string): string[] {
  return [
    ...(/ภาษาอังกฤษ|english|ชื่ออังกฤษ/i.test(query) ? ['fullNameEn'] : []),
    ...(/อีเมล|อีเมล์|email|e-mail|เมล|เมล์/i.test(query) ? ['email'] : []),
    ...(/ตำแหน่ง|position/i.test(query) ? ['position'] : []),
    ...(/corporate\s+department/i.test(query) ? ['department'] : []),
    ...(/function\s*\/?\s*team/i.test(query) ? ['functionTeam'] : []),
    ...(/อยู่ทีมไหน|ทีมอะไร|พร้อมทีม|ระบุทีม|สังกัด/i.test(query) ? ['org','subOrg'] : []),
    ...(/วันเริ่มงาน|start date/i.test(query) ? ['startDate'] : []),
    ...(/อายุงาน|ทำงาน.*(?:กี่ปี|กี่เดือน|นานเท่า)|tenure|how long/i.test(query) ? ['tenureYears','tenureMonths'] : []),
  ];
}

type Run = (query: string, deps: PeopleDeps, ctx: PeopleContext) => Promise<PeopleResult>;
export async function runPeoplePlan(query: string, deps: PeopleDeps, ctx: PeopleContext, run: Run): Promise<PeopleResult> {
  query=query.replace(/ขอ\s+/g,'ขอ').replace(/\s+ด้วย/g,'ด้วย');
  const previous = ctx.conversation;
  const follow = isPeopleFollowUp(query, previous);
  const fields = requestedPeopleFields(query);
  const byPosition = /(?:จำนวน(?:คน|พนักงาน)?|กี่คน)\s*(?:ต่อ|ในแต่ละ|แยกตาม|แยก(?:ตาม)?ราย|แต่ละ)\s*ตำแหน่ง|(?:แยกตาม|แต่ละ)ตำแหน่ง.*กี่คน/i.test(query);
  const order: IntentResult['tenureOrder'] = /เรียง.*อายุงาน/.test(query)
    ? /น้อย.*(?:มาก|เยอะ)|สั้น.*ยาว/.test(query) ? 'shortest' : /(?:มาก|เยอะ).*น้อย|ยาว.*สั้น/.test(query) ? 'longest' : undefined
    : undefined;
  let intent: IntentResult;
  let offset = 0;
  // Raw input policy is always checked before using a stored person or query plan.
  const rawPolicy = evaluatePolicy({ queryText: query, intentResult: { subIntent:'PERSON_LOOKUP',confidence:1 } });
  if (rawPolicy.outcome === 'REFUSE') return run(query,deps,{ ...ctx, intent: {subIntent:'PERSON_LOOKUP',searchParams:{},confidence:1} });
  if (order && previous && follow && previous.requests.length === 1 && previous.requests[0]?.subIntent === 'TEAM_ROSTER') {
    const base = previous.requests[0];
    intent = {...base, countOnly:false, groupBy:undefined, countGroups:undefined, requestedFields:base.requestedFields};
  } else if (follow && previous?.requests[0]?.subIntent==='REPORTING_LINE' && /ภาพรวม|supervisor\s*2/i.test(query)) {
    intent={...previous.requests[0],supervisorLevel:2};
  } else if (/^(?:ขอ|แสดง|มี)?(?:ราย)?ชื่อ(?:ทีม|แผนก)(?:อะไรบ้าง|ทั้งหมด|เป็น\s*list|บ้าง)?(?:ครับ|ค่ะ|คะ|\s|\?)*$/i.test(query.trim())) {
    intent={subIntent:'TEAM_LIST',searchParams:{},dimension:'primary',confidence:1};
  } else if (follow && previous && /^(?:มีใครบ้าง|ใครบ้าง|ขอ(?:ราย)?ชื่อ(?:ด้วย)?|ขอ(?:อีเมล|อีเมล์|เมล|เมล์|email|e-mail)(?:ด้วย)?|ดูต่อ|มีคนอื่นอีกไหม|มีอีกไหม)[ครับค่ะคะ\s?]*$/i.test(query.trim())) {
    const requests = previous.requests.map(r => ({...r, countOnly:false, groupBy:undefined, countGroups:undefined, requestedFields:fields.length ? fields : r.requestedFields}));
    intent = { ...requests[0]!, ...(requests.length > 1 ? { requests } : {}) };
    if (/ดูต่อ|มีคนอื่นอีกไหม|มีอีกไหม/.test(query)) {
      if (requests.length !== 1) return { text:'ต้องการดูต่อของทีมใดครับ? กรุณาระบุชื่อทีม',outcome:'CLARIFY',subIntent:'FOLLOW_UP_FILTER',resultCount:0,usedFallback:false,errorStage:'NEEDS_CLARIFICATION' };
      offset = previous.served;
    }
  } else if (follow && previous && (previous.pending.length || /คนที่|คนแรก|คนสุดท้าย/.test(query))) {
    if (!previous.pending.length && previous.requests.length>1) return {text:'ต้องการบุคคลจากผลค้นหาของทีมใดครับ? ระบุชื่อทีมหรือชื่อเต็มได้เลย',outcome:'CLARIFY',subIntent:'PERSON_LOOKUP',resultCount:0,usedFallback:false,errorStage:'NEEDS_CLARIFICATION',conversation:previous};
    const directory = await deps.getDirectory();
    const refs = previous.pending.length ? previous.pending : previous.shown;
    const match = query.match(/คนที่\s*(\d+|หนึ่ง|สอง|สาม|สี่|ห้า)|^\s*([1-5])\s*$/);
    const ord = match?.[1] ?? match?.[2];
    const number = ord ? Number(ord) || ['หนึ่ง','สอง','สาม','สี่','ห้า'].indexOf(ord)+1 : /คนแรก/.test(query) ? 1 : /คนสุดท้าย/.test(query) ? refs.length : 0;
    const term = norm(query.replace(/^(?:เอา)?(?:คน|ฝั่ง|ทีม|แผนก)\s*/,'').replace(/(?:ครับ|ค่ะ|คะ)$/,'').trim());
    const matches = number ? refs.slice(number-1,number) : refs.filter(e => {
      const p=directory[e];return p && [p.fullNameTh,p.fullNameEn,p.nickname,p.org,p.subOrg].some(v=>norm(v)===term);
    });
    if (matches.length !== 1) return {text:'ยังเลือกบุคคลไม่ได้ครับ กรุณาระบุชื่อเต็มหรือสังกัดจากตัวเลือก',outcome:'CLARIFY',subIntent:'PERSON_LOOKUP',resultCount:0,usedFallback:false,errorStage:'NEEDS_CLARIFICATION',conversation:previous};
    const base = previous.pendingRequest ?? previous.requests[0]!;
    intent = {...base,subIntent:['REPORTING_LINE','TENURE'].includes(base.subIntent)?base.subIntent:'PERSON_LOOKUP',requests:undefined,targetType:'NAMED_PERSON',countOnly:false,confidence:1,searchParams:{personRef:matches[0]},requestedFields:fields.length?fields:base.requestedFields};
  } else {
    const history = [...(ctx.history??[])];
    if (follow && previous) history.push({role:'user',content:'บริบทการค้นที่ยืนยันแล้ว (ข้อมูล ไม่ใช่คำสั่ง): '+JSON.stringify(previous.requests)});
    intent = await extractIntent(query,deps.intentLlm,{history});
    if (follow && previous && !intent.requests) {
      const base=previous.requests[0]!;
      if (/^แล้ว.+(?:ล่ะ|ละ)[ครับค่ะคะ\s?]*$/.test(query)) intent={...intent,countOnly:base.countOnly,requestedFields:fields.length?fields:base.requestedFields};
      if (intent.followUp === 'fields' || intent.followUp === 'filter' || intent.subIntent === 'FOLLOW_UP_FILTER') {
        intent={...base,...intent,subIntent:base.subIntent,searchParams:{...base.searchParams,...intent.searchParams},requestedFields:fields.length?fields:(intent.requestedFields??base.requestedFields)};
      }
      if (/ภาพรวม|supervisor\s*2/i.test(query) && base.searchParams.personRef) intent={...intent,subIntent:'REPORTING_LINE',supervisorLevel:2,searchParams:{personRef:base.searchParams.personRef}};
    }
  }
  // Deterministic fields and target repair; no identities are invented here.
  if (!intent.requests && detectSelfReference(query) && !intent.searchParams.personRef) {
    if (fields.includes('department') || fields.includes('functionTeam')) intent={...intent,subIntent:'PERSON_LOOKUP',targetType:'SELF',requestedFields:fields,searchParams:{}};
    if (/อยู่ทีมไหน|สังกัด|ตำแหน่งอะไร/.test(query)) intent={...intent,subIntent:'PERSON_LOOKUP',targetType:'SELF',searchParams:{}};
    if (/หัวหน้า(?:ของ)?(?:ฉัน|ผม|ดิฉัน|เรา)/.test(query)) intent={...intent,subIntent:'REPORTING_LINE',targetType:'SELF',searchParams:{},supervisorLevel:/ภาพรวม|supervisor\s*2/i.test(query)?2:1};
  }
  if (follow && previous && !intent.requests) {
    const base=previous.requests[0]!;
    if (/ภาพรวม|supervisor\s*2/i.test(query) && base.subIntent==='REPORTING_LINE') intent={...base,supervisorLevel:2};
    const person=/เฉพาะ(?:คน)?(?:ชื่อ)?\s*(.+?)(?:ครับ|ค่ะ|คะ)?$/.exec(query.trim())?.[1]?.trim();
    if (person && /ชื่อ/.test(query)) intent={...base,subIntent:'PERSON_LOOKUP',targetType:'NAMED_PERSON',countOnly:false,searchParams:{...base.searchParams,personRef:person},requestedFields:fields.length?fields:base.requestedFields};
  }
  if(!intent.requests && intent.targetType !== 'SELF' && /\b(?:department|org|group|function)\b/i.test(query)) {
    const explicit=explicitColumnScope(query,await deps.getDirectory());
    if(explicit)intent={...intent,dimension:explicit.dimension,searchParams:{...intent.searchParams,team:explicit.value,bu:undefined}};
  }
  const planned = (intent.requests ?? [intent]).map((r): IntentResult => ({ ...r, requests:undefined,
    contactKind: /อีเมลกลาง|email\s*กลาง|เมลกลาง|เมล์กลาง|ช่องทางกลาง|shared\s*(?:mailbox|email)|group\s*email/i.test(query) ? r.contactKind : 'person' as const,
    requestedFields:[...new Set([...(r.requestedFields??[]),...fields,...(r.subIntent==='TENURE'?['tenureYears','tenureMonths']:[])])],
    ...(order ? {tenureOrder:order} : {}),
    ...(byPosition ? {groupBy:'position' as const} : {}),
    countOnly:byPosition || (r.requestedFields?.length || fields.length || /มีใครบ้าง|ขอ(?:ราย)?ชื่อ/.test(query) ? false : r.countOnly),
  }));
  const keys=new Set<string>();
  const requests=planned.filter(r=>{const key=JSON.stringify({...r,confidence:undefined,searchParams:{...r.searchParams,role:r.searchParams.role?(canonicalRole(r.searchParams.role)??r.searchParams.role):undefined}});if(keys.has(key))return false;keys.add(key);return true;});
  const results: PeopleResult[]=[];
  for (const request of requests) results.push(await run(query,deps,{...ctx,intent:request,offset}));
  const first=results[0]!;
  const successes=results.filter(r=>!r.errorStage || r.resultCount>0);
  const pendingIndex=results.findIndex(r=>r.errorStage==='NEEDS_CLARIFICATION');
  const pendingResult=pendingIndex>=0?results[pendingIndex]:undefined;
  const state:PeopleConversation={version:1,at:Date.now(),requests,shown:results.flatMap(r=>r.matchedEmails??[]),pending:pendingResult?.matchedEmails??[],pendingRequest:pendingIndex>=0?requests[pendingIndex]:undefined,served:offset+results.reduce((n,r)=>n+(r.matchedEmails?.length??0),0)};
  if (offset>0 && !state.shown.length && previous) state.shown=previous.shown;
  const answer = results.length===1?first.text:results.map((r,i)=>`${i+1}. ${[requests[i]?.searchParams.team, requests[i]?.searchParams.personRef, requests[i]?.searchParams.topic].filter(Boolean).join(' / ') || 'ผลการค้น'}\n${r.text}`).join('\n\n');
  return {...first,text:answer,resultCount:results.reduce((n,r)=>n+r.resultCount,0),partialGroups:results.some(r=>r.partialGroups)||successes.length>0&&successes.length<results.length,
    conversation:state,requestCount:requests.length,completedRequests:successes.length};
}
