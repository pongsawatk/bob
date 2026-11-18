import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarAnswer } from '../src/kb/holidays.js';
import { selectDocs } from '../src/kb/select.js';
import { retrievalQuery } from '../src/kb/query.js';
import { roomAvailabilityAnswer } from '../src/kb/policyEvidence.js';
import { decideRoute } from '../src/pipeline/routePolicy.js';

const clock = new Date('2026-11-18T03:00:00Z');
const route = { category: 'PEOPLE' as const, needsClarification: true };
const user = (content: string) => ({ role: 'user' as const, content });

test('month and year answers list actual calendar rows and never answer a policy question with dates', () => {
  for (const question of ['เดือนธันวาหยุดวันไหน', 'วันหยุดเดือน ธันวาคม 2026', 'วันหยุดปี 69 เดือน ธ.ค.']) {
    const answer = calendarAnswer(question, clock)!;
    assert.match(answer, /2 วัน/);
    assert.match(answer, /7 ธ.ค./);
    assert.match(answer, /31 ธ.ค./);
  }
  assert.match(calendarAnswer('ขอวันหยุดนักขัตฤกษ์ปี 69', clock)!, /17 วัน/);
  for (const question of ['วันหยุดปี 2570', 'วันหยุดเดือนธันวาคมคิด OT ยังไง', 'ขอวันหยุดเดือนธันวาและมกราคม', 'วันหยุด 31 ธันวาคมปีนี้']) {
    assert.equal(calendarAnswer(question, clock), undefined);
  }
});

test('follow-up keeps the uniform topic and selects relevant evidence over unrelated HR policies', () => {
  const history = [user('เสื้อบริษัทมีแจกไหม'), { role: 'assistant' as const, content: 'ตามคู่มือ …' }];
  const docs = ['## เสื้อพนักงาน\nแหล่งอ้างอิง: https://example.org/shirts\nบริษัทแจกเสื้อโปโล',
    '## หมวด 6 การทำงานล่วงเวลา\nแหล่งอ้างอิง: https://example.org/ot\nการจ่ายค่าล่วงเวลา',
    '## อาหารกลางวัน\nแหล่งอ้างอิง: https://example.org/lunch\nอาหารกลางวัน'];
  const picked = selectDocs('ได้ทุกปีไหม', docs.join('\n\n---\n\n'), history);
  assert.equal(picked.contextUsed, true);
  assert.deepEqual(picked.sources?.map(s => s.url), ['https://example.org/shirts']);
  assert.deepEqual(selectDocs('OT คิดยังไง', docs.join('\n\n---\n\n')).sources?.map(s => s.url), ['https://example.org/ot']);
});

test('live room availability is distinguished from static booking instructions', () => {
  const kb = '## ระเบียบออฟฟิศ\nแหล่งอ้างอิง: https://example.org/rooms\nห้องประชุมต้องจองผ่าน Outlook';
  const answer = roomAvailabilityAnswer('วันที่ 26/11 มีห้องประชุมไหนว่างบ้าง', kb)!;
  assert.match(answer, /ตรวจ.*(?:สด|เวลาจริง)/);
  assert.match(answer, /Outlook/);
  assert.doesNotMatch(roomAvailabilityAnswer('ห้องประชุมว่างไหม', '')!, /Outlook/);
  assert.equal(roomAvailabilityAnswer('มี Map ห้องประชุมไหม', kb), undefined);
});

test('the normal HR entry point answers a supported calendar year without a KB or model call', async () => {
  process.env.OPENROUTER_API_KEY ??= 'test-dummy';
  const { callDomainBot } = await import('../src/pipeline/domainBot.js');
  const unavailable = async (): Promise<never> => { throw Error('unexpected remote fetch'); };
  const answer = await callDomainBot('HR', 'วันหยุดเดือนธันวาคม 2026', undefined, undefined, [], undefined,
    { getHRBundle: unavailable, getProductBundle: unavailable });
  assert.equal(answer.costUsd, 0);
  assert.equal(answer.model, '');
  assert.match(answer.text, /31 ธ.ค./);
});

test('route doc-navigation and reuse an explicitly selected timesheet system within the topic', () => {
  assert.equal(decideRoute(route, 'สามารถดูแผนผังองค์กรได้ที่ไหน').category, 'HR');
  assert.equal(decideRoute(route, 'แผนผังองค์กรทั้งบริษัท').category, 'PEOPLE');
  assert.equal(decideRoute(route, 'ใครดูแลห้องประชุม').category, 'PEOPLE');
  const history = [user('วิธีลง Timesheet'), user('ใน Pojjaman ค่ะ')];
  assert.match(retrievalQuery('ขอวิธีลง Timesheet แต่ละขั้นตอน', history), /pojjaman/);
  assert.equal(decideRoute(route, 'ขอวิธีลง Timesheet แต่ละขั้นตอน', history).clarification, undefined);
  assert.ok(decideRoute(route, 'ขอวิธีลง Timesheet', [...history, user('OT คิดยังไง')]).clarification);
});

test('a verified previous source can break a tie; an assistant-only URL cannot supply evidence', () => {
  const primary = '## เสื้อพนักงาน\nแหล่งอ้างอิง: https://example.org/benefit\n' + 'เสื้อพนักงาน '.repeat(1000);
  const other = (n: number) => '## เสื้อพนักงาน\nแหล่งอ้างอิง: https://example.org/other' + n + '\n' + 'เสื้อพนักงาน '.repeat(1000);
  const history = [user('เสื้อบริษัทมีแจกไหม'), { role: 'assistant' as const,
    content: '[คู่มือ](https://example.org/benefit) [ข้อความ](https://example.org/unknown)' }];
  const picked = selectDocs('ได้ทุกปีไหม', [other(1), other(2), primary].join('\n\n---\n\n'), history);
  assert.ok(picked.sources?.some(s => s.url === 'https://example.org/benefit'));
  assert.ok(!picked.bundle.includes('https://example.org/unknown'));
});
