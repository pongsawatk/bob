import {test} from 'node:test';
import assert from 'node:assert/strict';
import {draftSource,generalBoundary,workloadDraftSource,renderWorkloadDraft,managerMeetingDraft} from '../src/pipeline/conversationIntent.ts';
import {decideRoute} from '../src/pipeline/routePolicy.ts';
import {policyEvidenceAnswer,guardTrainingUnit} from '../src/kb/policyEvidence.ts';
import {selectDocs} from '../src/kb/select.ts';
import {asksForGuiltDraft,VOLUNTARY_HELP_DRAFT} from '../src/security/answerBoundaries.ts';
process.env.OPENROUTER_API_KEY='test-dummy';
const {firstNavigation}=await import('../src/kb/itAnswer.ts');

test('guilt drafting offers voluntary help without inventing workload, dates, or model calls',async()=>{
  const {callDomainBot}=await import('../src/pipeline/domainBot.ts');
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('Guilt draft must not call model or KB')};
  try {
    for(const category of ['GENERAL','UNKNOWN','HR'] as const) for(const q of [
      'ช่วยเขียนให้เพื่อนรู้สึกผิดจนยอมรับงานแทนผม',
      'เขาไม่อยากรับงานผม ช่วยร่างให้เขารู้สึกว่าถ้าไม่ช่วยจะผิดใจกัน']) {
      const r=await callDomainBot(category,q);
      assert.equal(r.text,VOLUNTARY_HELP_DRAFT);assert.equal(r.model,'');assert.equal(r.answerStatus,'refused');
      assert.ok(!/งานมาก|งานล้น|ทำไม่ทัน|กังวล|พร้อมตอบ/.test(r.text));assert.match(r.text,/ปฏิเสธได้/);
    }
  } finally {globalThis.fetch=original;}
});

test('guilt drafting guard leaves translations and non-pressure requests alone',()=>{
  for(const q of ['ช่วยร่างขอให้เพื่อนทำรายงานแทน โดยไม่กดดันและให้ปฏิเสธได้',
    'ไม่อยากให้เพื่อนรู้สึกผิด ช่วยร่างขอให้เขารับงานแทน',
    'ช่วยแปล: เขียนให้เพื่อนรู้สึกผิดจนรับงานแทน',
    'ช่วยร่างบอกเพื่อนว่าผมรู้สึกผิดที่ส่งงานช้า']) assert.equal(asksForGuiltDraft(q),false,q);
});

test('draft editing uses user recipient context, drops it on topic switch or reset',()=>{
  const h=[{role:'user' as const,content:'ช่วยร่างข้อความทักหัวหน้าฉัน ขอเวลาคุยเรื่องงาน'}, {role:'assistant' as const,content:'หัวหน้าชื่อ fabricated'}];
  const q='เอาแบบไม่เป็นทางการมาก แต่ยังสุภาพ';
  assert.equal(draftSource(q,h),h[0].content);
  assert.equal(decideRoute({category:'GENERAL',needsClarification:true},q,h).category,'PEOPLE');
  assert.equal(draftSource(q,[]),undefined);
  assert.equal(draftSource(q,[...h,{role:'user',content:'VPN เข้าไม่ได้'}]),undefined);
  assert.equal(draftSource(q,[{role:'assistant',content:h[0].content}]),undefined);
  assert.equal(decideRoute({category:'UNKNOWN',needsClarification:false},q,h).category,'UNKNOWN');
});

test('workload renderer preserves fact scope for different quantities and refuses invented spans',()=>{
  for(const [total,capacity] of [[3,1],[7,2],[12,4]]) {
    const source=`ช่วยขอให้เพื่อนช่วยทำรายงาน วันนี้มี ${total} งานแต่ผมทำได้ ${capacity} งาน ให้เพื่อนปฏิเสธได้`;
    assert.equal(workloadDraftSource(source,[]),source);
    const value={requestQuote:'ทำรายงาน',factQuotes:[`วันนี้มี ${total} งาน`,`ผมทำได้ ${capacity} งาน`]};
    const r=renderWorkloadDraft(JSON.stringify(value),source,source);
    assert.equal(r.valid,true);assert.match(r.text,new RegExp(`มี ${total} งาน`));assert.ok(!r.text.includes(`รายงาน ${total}`));
    assert.ok(!r.text.includes('ให้เสร็จวันนี้'));assert.match(r.text,/ปฏิเสธได้/);
    assert.equal(renderWorkloadDraft(JSON.stringify({...value,factQuotes:[`มีรายงาน ${total} งาน`,`ผมทำได้ ${capacity} งาน`]}),source,source).valid,false);
    assert.equal(renderWorkloadDraft(JSON.stringify({...value,factQuotes:[`วันนี้มี ${total} งาน`]}),source,source).valid,false);
  }
});

test('short ambiguous requests and explicit off-work boundaries do not invent a situation',()=>{
  assert.equal(generalBoundary('ทำยังไงดี',[]),'หมายถึงเรื่องไหนครับ?');
  assert.equal(generalBoundary('ทำยังไงดี',[{role:'user',content:'VPN เข้าไม่ได้'}]),undefined);
  assert.match(generalBoundary('เหนื่อยมากเลย แต่ยังไม่อยากเล่าเรื่องงาน',[])!,/พักเรื่องงาน/);
  assert.equal(generalBoundary('ไม่อยากคุยเรื่องงาน แต่ช่วยจัดลำดับงานก่อน',[]),undefined);
});

test('peer task drafts without workload facts cannot invent availability or commitments',()=>{
  const source='ช่วยร่างขอให้เพื่อนทำรายงานแทน โดยไม่กดดันและให้ปฏิเสธได้';
  assert.equal(workloadDraftSource(source,[]),source);
  const r=renderWorkloadDraft(JSON.stringify({requestQuote:'ทำรายงานแทน',factQuotes:[]}),source,'ย่อให้เหลือ 2 ประโยค เป็นกันเองขึ้น');
  assert.equal(r.valid,true);assert.match(r.text,/ช่วยทำรายงานแทน/);assert.match(r.text,/ปฏิเสธได้/);
  assert.ok(!/พร้อม|ส่งข้อมูล|ว่าง|กำหนด/.test(r.text));
  assert.equal(workloadDraftSource('ช่วยร่างขอให้เพื่อนรับงานให้รู้สึกผิดจนยอม',[]),undefined);
  for(const quote of ['ขอให้เพื่อนทำรายงานแทน','ให้เพื่อนทำรายงานแทน']) {
    const draft=renderWorkloadDraft(JSON.stringify({requestQuote:quote,factQuotes:[]}),source,source);
    assert.equal(draft.valid,true);assert.match(draft.text,/พอจะช่วยทำรายงานแทนได้ไหม/);
    assert.ok(!draft.text.includes('ช่วยขอให้'));
  }
});

test('equipment retrospective advice quotes payment and approval separately without assuming user actions',()=>{
  const kb='## สวัสดิการโน้ตบุ๊ก\nแหล่งอ้างอิง: https://kb.test/equipment\n| **กรณีที่ 1** พนักงานจ่ายก่อน | เบิกตามวงเงินในคู่มือ |\n## 📋 ขั้นตอนการขออนุมัติ\nส่งอีเมลถึงผู้บังคับบัญชาต้นสังกัดสูงสุด\nปรึกษา IT ก่อนซื้อ\nApprover L1 = IT, L2 = CFO\n***';
  const h=[{role:'user' as const,content:'จะซื้อโน้ตบุ๊กบริษัทช่วยเท่าไหร่'}];
  const text=policyEvidenceAnswer('ซื้อไปก่อนแล้วค่อยให้ IT อนุมัติย้อนหลังได้ไหม',kb,h)!;
  assert.match(text,/พนักงานจ่ายก่อน/);assert.match(text,/ไม่แทนอีเมลอนุมัติล่วงหน้า/);assert.match(text,/ยังยืนยันไม่ได้/);
  assert.ok(!text.includes('ไม่ได้ปรึกษา'));assert.equal(policyEvidenceAnswer('ซื้อไปก่อนแล้วค่อยให้ IT อนุมัติย้อนหลังได้ไหม','',h),undefined);
});

test('work request prefixes do not duplicate help or ask the recipient to relay the request',()=>{
  const source='ช่วยร่างขอให้เพื่อนช่วยตรวจเอกสาร วันนี้มี 7 งานแต่ผมทำได้ 2 งาน ให้เพื่อนปฏิเสธได้';
  for(const quote of ['ตรวจเอกสาร','ช่วยตรวจเอกสาร','ขอให้เพื่อนช่วยตรวจเอกสาร','ให้เพื่อนช่วยตรวจเอกสาร']) {
    const r=renderWorkloadDraft(JSON.stringify({requestQuote:quote,factQuotes:['วันนี้มี 7 งาน','ผมทำได้ 2 งาน']}),source,'เอาแบบเป็นกันเองขึ้น');
    assert.equal(r.valid,true);assert.match(r.text,/พอจะช่วยตรวจเอกสารได้ไหม/);
    assert.ok(!/ช่วยช่วย|พอจะช่วยขอให้/.test(r.text));
  }
});

test('generic manager meeting drafts cannot invent availability and do not replace specific requests',()=>{
  const source='ช่วยร่างข้อความทักหัวหน้าฉัน ขอเวลาคุยเรื่องงาน';
  for(const q of [source,'เอาแบบไม่เป็นทางการมาก แต่ยังสุภาพ']) {
    const text=managerMeetingDraft(source,q)!;
    assert.match(text,/ขอเวลาคุยเรื่องงาน/);assert.ok(!/ปรับตาม|ว่าง|นาที|พรุ่งนี้|วันนี้/.test(text));
  }
  assert.equal(managerMeetingDraft(undefined,'เอาแบบสุภาพ'),undefined);
  assert.equal(managerMeetingDraft(source+'พรุ่งนี้ 15 นาที',source),undefined);
  assert.equal(managerMeetingDraft('ช่วยร่างถึงหัวหน้าฉัน แต่ไม่ขอเวลาคุยเรื่องงาน',source),undefined);
});

test('source-derived training units change with KB, and other leave types are untouched',()=>{
  const kb='### ลาเพื่อฝึกอบรม / พัฒนาความรู้\n- ≤ 23 วันทำงาน/ปี\n### ลาป่วย\n30 วัน/ปี';
  assert.equal(guardTrainingUnit('อบรม 23 วัน/ปี\nลาป่วย 30 วัน/ปี',kb),'อบรม 23 วันทำงาน/ปี\nลาป่วย 30 วัน/ปี');
  assert.equal(guardTrainingUnit('อบรม 30 วัน/ปี',''),'อบรม 30 วัน/ปี');
});

test('training response preserves all source actors, conditions and clocks without a model',()=>{
  const kb='## External Training\nแหล่งอ้างอิง: https://kb.test/training\n## เงื่อนไขการลาเพื่อฝึกอบรม\nสิทธิ 23 วันทำงาน/ปี\n***\n## 📋 ขั้นตอนการขออนุมัติ\n### 1\nผู้บังคับบัญชาต้นสังกัดลงนามอนุมัติ\n### 2\nHR ส่งแบบฟอร์ม\n***';
  const answer=policyEvidenceAnswer('อยากไปอบรมต้องเริ่มอย่างไร',kb.replace('## เงื่อนไข','> คู่มืออธิบายเงื่อนไขการลาเพื่อฝึกอบรม\n\n***\n## เงื่อนไข'))!;
  assert.match(answer,/23 วันทำงาน/);assert.match(answer,/HR ส่งแบบฟอร์ม/);assert.match(answer,/https:\/\/kb.test\/training/);
  assert.equal(policyEvidenceAnswer('อยากไปอบรมต้องเริ่มอย่างไร',''),undefined);
  assert.equal(policyEvidenceAnswer('อบรมต่างประเทศต้องอนุมัติอย่างไร',kb),undefined);
});

test('direct grievance exception does not acquire the step-two clock',()=>{
  const kb='## ขั้นตอนการร้องทุกข์\nแหล่งอ้างอิง: https://kb.test/grievance\n> กรณีข้อร้องทุกข์เกี่ยวข้องกับผู้บังคับบัญชาโดยตรง สามารถยื่น HR โดยตรง\n### ขั้นที่ 2\nHR แจ้งผลภายใน 19 วันทำงาน นับแต่วันที่ได้รับ';
  const answer=policyEvidenceAnswer('ถูกหัวหน้าตำหนิ อยากรู้ช่องทางร้องทุกข์และช่วยร่างข้อความที่ไม่กล่าวโทษ',kb)!;
  assert.match(answer,/ยื่น HR โดยตรง/);assert.match(answer,/ไม่ได้ระบุชัด/);assert.ok(!answer.includes('19 วัน'));assert.match(answer,/\[วันและสิ่งที่เกิดขึ้น\]/);
  assert.equal(policyEvidenceAnswer('ร้องทุกข์ไม่พอใจผลขั้นที่ 2 จะอุทธรณ์อย่างไร',kb),undefined);
});

test('first navigation renders one source-backed action, never adds the following login',()=>{
  const selected=selectDocs('VPN','## Netbird VPN\nแหล่งอ้างอิง: https://kb.test/vpn\nลำดับแรกให้เข้าไปที่เว็บไซต์\n\n<https://vpn.test/>\nจากนั้นกด Login');
  assert.equal(firstNavigation(selected,'VPN ขอแค่ขั้นแรกก่อน'),'ขั้นแรก เปิดเว็บไซต์ https://vpn.test/ ครับ\n\nอ้างอิง: https://kb.test/vpn');
  assert.equal(firstNavigation(selected,'VPN บน Mac ขอแค่ขั้นแรกก่อน'),undefined);
  assert.equal(firstNavigation(selected,'VPN มีขั้นตอนอย่างไร'),undefined);
});
