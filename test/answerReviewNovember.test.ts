import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAnswerShape, peopleOutcome } from '../src/pipeline/outcome.ts';
import { reviewSentAnswers } from '../src/analytics/answerReview.ts';
import { observationsToTraces, type RawTrace, type RawObservation } from '../src/analytics/langfuse.ts';

const roster = 'ทีมตัวอย่าง — พบทั้งหมด 3 คนครับ แสดง 2 คนในหน้านี้:\n1. คนตัวอย่าง — ตำแหน่ง: QA';
test('count-only, age and employment status are checked against the actual answer fields', () => {
  assert.equal(classifyAnswerShape('จำนวนคนต่อตำแหน่ง ไม่ต้องส่งรายชื่อ', roster, 'PEOPLE'), 'roster_instead_of_counts');
  assert.equal(peopleOutcome({text:roster},'จำนวนคนต่อตำแหน่ง').answerStatus,'partial');
  assert.equal(classifyAnswerShape('ขอจำนวนและรายชื่อ', roster, 'PEOPLE'), undefined);
  assert.equal(classifyAnswerShape('ขอจำนวนคนต่อตำแหน่งพร้อมรายชื่อ', roster, 'PEOPLE'), undefined);
  assert.equal(classifyAnswerShape('คุณ ก. อายุเท่าไหร่', '1. คนตัวอย่าง — อายุงาน (ปี): 3', 'PEOPLE'), 'tenure_instead_of_age');
  assert.equal(classifyAnswerShape('อายุงานเท่าไหร่', 'อายุงาน (ปี): 3', 'PEOPLE'), undefined);
  assert.equal(classifyAnswerShape('ลาออกหรือยัง', '1. คนตัวอย่าง — วันเริ่มงาน: 1 ม.ค.', 'PEOPLE'), 'start_date_instead_of_status');
  assert.equal(classifyAnswerShape('ลาออกหรือยัง', 'ยังยืนยันสถานะการจ้างไม่ได้ครับ ข้อมูลวันเริ่มงานไม่บอกสถานะ', 'PEOPLE'), undefined);
});
const turn = (id: string, input: string, output: string, delay = 0): RawTrace => ({
  id, name:'bob-chat', userId:'fixture-user', sessionId:'fixture-chat', timestamp:new Date(1800000000000 + delay).toISOString(),
  metadata:{category:'PEOPLE', channel:'teams', answerStatus:'answered', deliveryStatus:'sent'},
  input, output, totalCost:0.02
});
test('summary counts sent turns once, latest user vote per trace, human evidence and repeat signals separately', () => {
  const a=turn('a','จำนวนคนต่อตำแหน่ง',roster);
  const b=turn('b','จำนวนคนต่อตำแหน่ง','QA 3 คน',3000);
  const failed={...a,id:'c',metadata:{channel:'teams',deliveryStatus:'failed'}};
  const records=[{traceId:'a', name:'user-feedback',value:1,timestamp:'2026-11-03T00:00:00Z'},
    {traceId:'a',name:'user-feedback',value:0,timestamp:'2026-11-03T00:02:00Z'},
    {traceId:'b',name:'user-feedback',value:1,timestamp:'2026-11-03T00:01:00Z'},
    {traceId:'a',name:'answer-review',stringValue:'wrong_request',timestamp:'2026-11-03T00:03:00Z'}];
  const r=reviewSentAnswers([b,a,a,failed],records);
  assert.equal(r.sent,2); assert.equal(r.repeatRequests,1); assert.equal(r.signals.roster_instead_of_counts,1);
  assert.equal(r.feedback?.reviewed,2); assert.equal(r.feedback?.accepted,1); assert.equal(r.feedback?.reviewedCostPerAcceptedUsd,0.04);
  assert.equal(r.humanVerdicts?.wrong_request,1);
  assert.equal(r.humanReviewCosts?.reviewedCostPerAcceptedUsd, null);
  assert.equal(reviewSentAnswers([a],null).feedback,null);
  assert.equal(reviewSentAnswers([{...a,totalCost:null}],records).feedback?.reviewedCostPerAnswerUsd,null);
});
test('successful response labels do not establish a human quality verdict; genuine clarification is not a mismatch', () => {
  const t=turn('a','ห้องไหนว่างวันนี้','ยังไม่มีข้อมูลการจองสด ให้ตรวจใน Outlook');
  const r=reviewSentAnswers([t],[]);
  assert.deepEqual(r.humanVerdicts,{}); assert.equal(r.feedback?.accepted,0);
  assert.equal(r.feedback?.reviewedCostPerAcceptedUsd,null);
  const acceptedGap = reviewSentAnswers([t], [{ traceId:'a', timestamp:t.timestamp, name:'answer-review', stringValue:'appropriate_gap' }]);
  assert.equal(acceptedGap.humanReviewCosts?.accepted,1);
  assert.equal(acceptedGap.humanReviewCosts?.reviewedCostPerAcceptedUsd,.02);
});
test('an unpriced model call is not treated as free when reconstructing trace cost', () => {
  const root:RawObservation={id:'root',traceId:'t',name:'bob-chat',type:'SPAN',startTime:'2026-11-01',endTime:null,parentObservationId:null};
  const gen={...root,id:'g',type:'GENERATION',parentObservationId:'root'};
  assert.equal(observationsToTraces([root,gen])[0]?.costKnown,false);
  assert.equal(observationsToTraces([root,{...gen,totalCost:0}])[0]?.costKnown,true);
});
