import { canonicalQuery, retrievalQuery, type QueryTurn } from '../kb/query.js';
import type { RouterResult } from './router.js';

export interface RouteDecision { category: RouterResult['category']; clarification?: string; reason: string }
export function decideRoute(route: Pick<RouterResult, 'category' | 'needsClarification'>, question: string, history: readonly QueryTurn[] = []): RouteDecision {
  // Never turn an unsafe/unknown route into an allowed domain via a keyword hit.
  if (route.category === 'UNKNOWN') return { category: 'UNKNOWN', reason: 'unknown_route' };
  const q = retrievalQuery(question, history);
  // The source boundary takes precedence over a broad HR/GENERAL classification.
  // People lookup and benefit eligibility retain their existing sources.
  const people = /ใคร|สมาชิก|ทีม.*(?:กี่คน|มีใคร)|หัวหน้า/.test(q) && /ทีม|ฝ่าย|ดูแล|ติดต่อ|หัวหน้า|คน/.test(q);
  const benefit = /สวัสดิการ|สิทธิ์|สิทธิ|เบิก|เบี้ย|ชดเชย/.test(q);
  const it = /\b(?:vpn|netbird|2sv|dokploy|claude|kiro|mcp|obsidian|wsl2?|docker|traefik)\b|google workspace|2-step|outline|grab for business|เครื่องพิมพ์|พิมพ์ซอง|ไวไฟ|wi-?fi|ส่งมอบข้อมูล.*(?:ยกเลิก|pojjaman)|ยกเลิก.*ส่งมอบข้อมูล/i.test(q);
  if (it && !people && !benefit) return { category: 'IT', reason: 'it_documentation' };
  if (benefit && /อุปกรณ์|คอมพิวเตอร์|โน้ตบุ๊ค|โน้ตบุ๊ก|\bit\b/.test(q)) return { category: 'HR', reason: 'equipment_benefit' };
  if (/timesheet/.test(q)) {
    if (!/pojjaman|humansoft/.test(q)) return {
      category: 'HR', reason: 'timesheet_system_ambiguous',
      clarification: 'หมายถึง Timesheet บันทึกชั่วโมงโครงการใน Pojjaman หรือเวลาเข้า–ออกงานใน HumanSoft ครับ?',
    };
    return { category: 'HR', reason: 'timesheet_system_resolved' };
  }
  const current = canonicalQuery(question);
  const product = /\bploy\b|โปรแกรม\s*พลอย|ระบบ\s*พลอย/.test(current);
  if (product && /เบอร์กลาง|เบอร์ติดต่อ|ติดต่อ.*(?:โปรแกรม|ระบบ)|support|ฝ่ายขาย/.test(current)) {
    return { category: 'PRODUCT', reason: 'product_contact' };
  }
  if (/เบอร์.*บริษัท|ช่องทางติดต่อบริษัท|ที่อยู่.*บริษัท|ใบกำกับภาษี/.test(current)) {
    return { category: 'HR', reason: 'company_information' };
  }
  if (route.needsClarification) return {
    category: route.category, reason: 'router_requested_clarification',
    clarification: 'ต้องการทราบเรื่องไหนหรือทำขั้นตอนไหนในระบบใดครับ? ระบุเพิ่มสั้น ๆ ได้เลยครับ',
  };
  return { category: route.category, reason: 'model_route' };
}
