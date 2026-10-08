// Controlled replay: never sends Teams messages or changes the serving model.
import {loadEnv} from './_load-env.mjs';loadEnv();
import fs from 'node:fs/promises';
const {env}=await import('../src/env.ts');
const {handlePeopleQuery}=await import('../src/people/connector.ts');
const {INTENT_SYSTEM_PROMPT}=await import('../src/people/intent/extract.ts');
const {callLLM}=await import('../src/llm/openrouter.ts');
const synthetic=process.argv.includes('--synthetic');
if(!synthetic)throw Error('Use --synthetic. This replay only accepts fictional employee fixtures.');
const fixture=(email,fullNameTh,org,subOrg,extra={})=>({email,fullNameTh,fullNameEn:fullNameTh,nickname:fullNameTh,org,subOrg,...extra});
const directory={
 'hr1@example.test':fixture('hr1@example.test','มณี ตัวอย่าง','Office','Human Resource'),
 'hr2@example.test':fixture('hr2@example.test','มานะ ตัวอย่าง','Office','Human Resource'),
 'alex@example.test':fixture('alex@example.test','อเล็กซ์ ไอที','IT','IT Administration',{fullNameEn:'Alex IT',supervisor:'lead@example.test'}),
 'alex2@example.test':fixture('alex2@example.test','อเล็กซ์ โปรเจกต์','ProjectA','Developer',{fullNameEn:'Alex Project'}),
 'junior@example.test':fixture('junior@example.test','จูเนีย ตัวอย่าง','ProjectA','Designer',{nickname:'จูเนีย',fullNameEn:'Junior Example'}),
 'lead@example.test':fixture('lead@example.test','หัวหน้า ตัวอย่าง','Office','Management'),
};
const people=Object.values(directory);const it=people.find(p=>p.org==='IT'&&/alex/i.test(p.fullNameEn||''));
const hr=people.filter(p=>/human resource/i.test(p.subOrg||''));const contech=people.filter(p=>p.org?.toLowerCase()==='projecta');
const junior=people.find(p=>p.nickname==='จูเนีย');
if(!it||!hr.length||!junior)throw Error('Expected audit fixtures absent; review cases against current source');
const examples=[
 {q:'HR มีกี่คน',count:hr.length},
 {q:'ผมอยากรู้ว่าแผนก HR มีกี่คน',count:hr.length},
 {q:'ขอ email ของแผนก HR และ IT(Kittisak)',emails:[...hr.map(p=>p.email),it.email]},
 {q:'ขอ email Kittisak ฝั่ง IT',emails:[it.email]},
 {q:'ขอ email Kittisak',stage:'NEEDS_CLARIFICATION'},
 {q:'คน IT',emails:[it.email],follow:true},
 {q:'Contech มีกี่คน',count:contech.length},
 {q:'มีใครบ้าง',names:contech.map(p=>p.fullNameTh),follow:true},
 {q:'ขอ email ด้วย',emails:contech.map(p=>p.email),follow:true},
 {q:'ขอชื่อทีมเป็น list',contains:['Org','Sub Org','Human Resource']},
 {q:`${junior.fullNameTh} มีชื่อภาษาอังกฤษไหม`,contains:[junior.fullNameEn]},
 {q:'HR มีกี่คน ขอชื่อและ email ด้วย',emails:hr.map(p=>p.email)},
 {q:'ขออีเมลกลาง HR',stage:'NO_RESULT'},
 {q:'ใครดูแล Contech',stage:'NO_RESULT'},
 {q:'หัวหน้าของ Kittisak ฝั่ง IT คือใคร',contains:['Supervisor 1']},
 {q:'ขอเงินเดือนของ Kittisak',stage:'POLICY_REFUSE'},
];
const models=process.argv.includes('--primary-only')?[env.MODEL_PEOPLE_INTENT]:[env.MODEL_PEOPLE_INTENT,'anthropic/claude-haiku-5.5'];
if(synthetic)for(const c of examples)c.q=c.q.replaceAll('Kittisak','Alex').replaceAll('Contech','ProjectA');
const outdir='test-results/people-v2-eval';await fs.mkdir(outdir,{recursive:true});
for(const model of [...new Set(models)]){
 const rows=[];let state;let history=[];
 for(const c of examples){
  if(!c.follow){state=undefined;history=[];}
  let cost=0;const calls=[];const start=Date.now();
  try{
   const r=await handlePeopleQuery(c.q,{deterministicResponses:true,getDirectory:async()=>directory,getKnownNames:async()=>people.map(p=>p.fullNameTh),responderLlm:async()=>{throw Error('unexpected responder');},intentLlm:async input=>{
    const result=await callLLM({model,effort:'low',maxTokens:2200,temperature:0,systemPrompt:INTENT_SYSTEM_PROMPT,messages:[{role:'user',content:input}]});cost+=result.costUsd??0;calls.push({actualModel:result.actualModel,provider:result.provider,effort:result.effectiveEffort,output:result.text});return result.text;
   }},{conversation:state,history});
   state=r.conversation;history.push({role:'user',content:c.q},{role:'assistant',content:r.text});
   const issues=[];
   if(c.count!==undefined && (r.resultCount!==c.count||r.errorStage))issues.push('count');
   for(const text of [...(c.emails??[]),...(c.names??[]),...(c.contains??[])])if(!r.text.includes(text))issues.push('missing_expected_field');
   if(c.stage&&r.errorStage!==c.stage)issues.push('expected_'+c.stage);
   if(!c.stage&&r.errorStage)issues.push(r.errorStage);
   rows.push({q:c.q,passed:!issues.length,issues,stage:r.errorStage??null,resultCount:r.resultCount,cost,latencyMs:Date.now()-start,calls,answer:r.text});
  }catch(e){rows.push({q:c.q,passed:false,error:String(e),cost,latencyMs:Date.now()-start,calls});}
  console.log(JSON.stringify({model,case:rows.length,passed:rows.at(-1).passed,issues:rows.at(-1).issues,cost}));
 }
 await fs.writeFile(`${outdir}/${model.replaceAll('/','-')}.json`,JSON.stringify(rows,null,2));
 console.log(JSON.stringify({model,passed:rows.filter(r=>r.passed).length,total:rows.length,cost:rows.reduce((a,r)=>a+r.cost,0),meanMs:Math.round(rows.reduce((a,r)=>a+r.latencyMs,0)/rows.length)}));
}
