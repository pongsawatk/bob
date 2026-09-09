import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDocs } from '../src/kb/select.js';
import { timesheetEditGap } from '../src/kb/taskEvidence.ts';

// Synthetic, deidentified documents model the competing titles seen in E018/E038.
const doc = (title: string, text: string) => `## ${title}\nแหล่งอ้างอิง: https://kb.test/${encodeURIComponent(title)}\n${text}`;
const bundle = [
  ...Array.from({ length: 8 }, (_, i) => doc(`สวัสดิการ นโยบาย เอกสาร การแก้ไข ${i}`, 'สวัสดิการ เอกสาร แบบฟอร์ม นโยบาย '.repeat(130))),
  doc('หมวด 7 — วันลาและหลักเกณฑ์การลา', 'สิทธิ์ลาป่วย ลากิจ ลาพักผ่อน'),
  doc('การบันทึก Timesheet ระบบ Pojjaman', 'คู่มือบันทึกชั่วโมงโครงการและตรวจสอบรายงาน'),
  doc('วันหยุดประจำปี', 'ปฏิทินวันหยุดบริษัท'),
  doc('วิธีการเดินทางมาออฟฟิศ', 'ที่อยู่สำนักงาน'),
].join('\n\n---\n\n');

for (const [question, title] of [
  ['สวัสดิการวันลา', 'หมวด 7 — วันลา'],
  ['วิธีแก้ไขไทมืชีท', 'การบันทึก Timesheet'],
  ['ลิงค์เอกสารไทม์ชีท', 'การบันทึก Timesheet'],
  ['วันหยุดปีนี้', 'วันหยุดประจำปี'],
]) test(`retrieval acceptance: ${question}`, () => {
  assert.ok(selectDocs(question, bundle).bundle.includes(title));
});

test('short follow-up retains the user topic, but a new topic does not', () => {
  const history = [{ role: 'user' as const, content: 'วิธีแก้ไขไทม์ชีท Pojjaman' }];
  assert.ok(selectDocs('ขอลิงก์หน่อย', bundle, history).bundle.includes('การบันทึก Timesheet'));
});

test('broad and small bundles preserve all sources, selection is deterministic', () => {
  assert.equal(selectDocs('ฉันลาอะไรได้บ้าง', bundle).bundle, bundle);
  assert.equal(selectDocs('อะไรก็ได้', '## Small\ncontent').bundle, '## Small\ncontent');
  assert.deepEqual(selectDocs('สวัสดิการวันลา', bundle), selectDocs('สวัสดิการวันลา', bundle));
});
test('Timesheet editing requires a task-specific section, not report menus or generic Save buttons', () => {
  const kb = doc('การบันทึก Timesheet', '## ตรวจสอบชั่วโมง\nเมนูรายงาน\nPMO') + '\n\n---\n\n' + doc('Pojjaman Approval', '## แก้ไขรายการ\nSave and Complete');
  const q = 'แก้ไข Timesheet Pojjaman';
  const gap = timesheetEditGap(q, kb);
  assert.match(gap!, /ยังไม่พบคู่มือ/);
  assert.doesNotMatch(gap!, /Save|เมนูรายงาน/);
  assert.match(gap!, /https:\/\/kb.test/);
  assert.equal(timesheetEditGap(q, doc('Timesheet', '## วิธีแก้ไขรายการ\nขั้นตอนที่ผู้ดูแลยืนยัน')), undefined);
  assert.equal(timesheetEditGap('บันทึก Timesheet Pojjaman', kb), undefined);
  assert.equal(timesheetEditGap('แก้เวลาเข้างาน HumanSoft', kb), undefined);
});
