import { retrievalQuery, type QueryTurn } from './query.js';

/** A report menu and generic Save buttons do not establish an edit workflow.
 * Re-enable model instructions when a Timesheet document explicitly covers editing.
 * This is a structural evidence gate, not a semantic accuracy classifier. */
export function timesheetEditGap(question: string, bundle: string, history: readonly QueryTurn[] = []): string | undefined {
  const q = retrievalQuery(question, history);
  if (!/timesheet/.test(q) || !/pojjaman/.test(q) || !/แก้(?:ไข)?|ปรับรายการ|\bedit\b/i.test(q)) return undefined;
  const docs = bundle.split('\n\n---\n\n').filter(b => /timesheet/i.test(b.split('\n')[0] ?? ''));
  if (docs.some(b => /^#{1,6}\s+[^\n]*(?:แก้ไข|แก้รายการ|\bedit(?:ing)?\b)/im.test(b))) return undefined;
  const source = docs.map(b => /แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(b)?.[1]).find(Boolean);
  const owner = docs.some(b => /PMO|Pojjaman Support/i.test(b)) ? '\n\nสอบถาม PMO / Pojjaman Support ตามคู่มือ พร้อมระบุว่ารายการยังไม่ส่ง ส่งแล้ว หรืออนุมัติแล้วครับ' : '';
  return 'ยังไม่พบคู่มือขั้นตอนแก้ไข Timesheet ใน Pojjaman ที่ระบุสถานะรายการและสิทธิ์ผู้แก้ไขครับ ข้อมูลที่มีจึงยังใช้ยืนยันเมนูแก้ไขหรือวิธีย้อนอนุมัติไม่ได้' + owner + (source ? `\n\nคู่มือที่มี: ${source}` : '');
}
