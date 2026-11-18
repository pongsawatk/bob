import { canonicalQuery, retrievalQuery, queryConcepts, type QueryTurn } from '../kb/query.js';
import type { RouterResult } from './router.js';
import { draftSource, generalBoundary } from './conversationIntent.js';
import { calendarAnswer } from '../kb/holidays.js';

export interface RouteDecision { category: RouterResult['category']; clarification?: string; reason: string }
export function decideRoute(route: Pick<RouterResult, 'category' | 'needsClarification'>, question: string, history: readonly QueryTurn[] = []): RouteDecision {
  // Never turn an unsafe/unknown route into an allowed domain via a keyword hit.
  if (route.category === 'UNKNOWN') return { category: 'UNKNOWN', reason: 'unknown_route' };
  const boundary=generalBoundary(question,history);
  if(boundary) return {category:'GENERAL',reason:'conversation_boundary',clarification:boundary};
  const q = retrievalQuery(question, history);
  const current = canonicalQuery(question);
  const topics = queryConcepts(current);
  if (calendarAnswer(question)) return {category:'HR',reason:'company_holiday_calendar'};
  if (topics.includes('org_chart') && /ลิงก์|ดู(?:ได้)?ที่ไหน|ดู.*ได้ที่ไหน|เปิด(?:ดู)?ที่ไหน|หาได้ที่ไหน/.test(current) &&
      !/รายชื่อ|อีเมล|ส่งออก|ดาวน์โหลด.*ทะเบียน/.test(current))
    return {category:'HR',reason:'org_chart_document'};
  const shirtPolicy = queryConcepts(q).includes('uniform') && /แจก|สวัสดิการ|ทุกปี|สิทธิ|ขอเสื้อ/.test(q);
  const roomPolicy = topics.includes('meeting_room') && /ว่าง|จอง|แผนผัง|map|ที่นั่ง|เลขที่ห้อง/.test(current);
  const otPolicy = topics.includes('overtime') && /คิด|อัตรา|เงื่อนไข|เบิก|ขั้นตอน|นโยบาย/.test(current);
  if ((shirtPolicy || roomPolicy || otPolicy) && !/ใคร|รายชื่อ|อีเมล|เบอร์โทร/.test(current))
    return {category:'HR',reason:'hr_policy_topic'};
  if (/(?:อีเมล|email|เมล).*กลาง|ช่องทางกลาง|shared\s*(?:mailbox|email)/i.test(current)) return {category:'PEOPLE',reason:'shared_contact'};
  if (/^(?:ขอ)?(?:ข้อมูล|รายละเอียด)?\s*(?:พลอย|ploy)(?:ครับ|ค่ะ|คะ|\s|\?)*$/i.test(current)) return {category:'GENERAL',reason:'product_person_ambiguity',clarification:'หมายถึงโปรแกรม Ploy CRM หรือบุคคลชื่อพลอยครับ?'};
  if (topics.includes('handover')) return {category:'IT',reason:'customer_data_handover'};
  if (topics.includes('leave') && !/(?:อายุงาน|ทำงานมา.*(?:กี่ปี|กี่เดือน))/.test(current)) return {category:'HR',reason:'leave_policy'};
  if (/agenda|จัดลำดับงาน|วางแผนงาน/.test(current) && !/bill\s*loader|insite|jubili|kwanjai|ขวัญใจ|ploy\s*crm|builk\s*360/i.test(current)) return {category:'GENERAL',reason:'explicit_general_task'};
  const personLookup=/email|อีเมล|อยู่ทีม|สมาชิก|รายชื่อ|หัวหน้า|ตำแหน่ง|ทีม.*(?:กี่คน|มีใคร)|ใคร.*(?:ดูแล|รับผิดชอบ)/.test(current);
  if (/bill\s*loader|insite|jubili|kwanjai|ขวัญใจ|ploy\s*crm|builk\s*360/i.test(q) && !personLookup) return {category:'PRODUCT',reason:'product_task'};
  if (/grab/i.test(q) && !/ใคร|สมาชิก|มีกี่คน/.test(current)) return {category:'IT',reason:'grab_procedure'};
  if (/จองตั๋ว|จ่ายเงิน.*(?:ให้ผม|ให้ฉัน|แทน)/.test(current)) return {category:'GENERAL',reason:'cannot_act_help'};
  const drafting = /ร่าง|agenda|จัดลำดับ|ข้อความ(?:เชิญ|คุย|แจ้ง)|ไม่เป็นทางการ|เป็นกันเองกว่านี้/.test(current);
  const source=draftSource(question,history);
  if (source && /หัวหน้า(?:ของ)?(?:ผม|ฉัน|ดิฉัน|เรา)/.test(source)) return {category:'PEOPLE',reason:'resolve_draft_recipient'};
  if (drafting && queryConcepts(q).includes('leave')) return {category:'HR',reason:'leave_draft_context'};
  if (drafting && !topics.length && !/timesheet|pojjaman|humansoft|อบรม|ร้องทุกข์|ลาป่วย|ลากิจ/.test(q)) return {category:'GENERAL',reason:'general_work_help'};
  if (/^(?:ขอ\s*)?(?:email|อีเมล|เมล)(?:\s*(?:เขา|ด้วย|ครับ|ค่ะ|คะ))*$/i.test(current.trim()) && !history.length) return {category:'PEOPLE',reason:'missing_person',clarification:'หมายถึงอีเมลของใครหรือทีมไหนครับ?'};
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
  const product = /\bploy\b|โปรแกรม\s*พลอย|ระบบ\s*พลอย/.test(current);
  if (product && /เบอร์กลาง|เบอร์ติดต่อ|ติดต่อ.*(?:โปรแกรม|ระบบ)|support|ฝ่ายขาย/.test(current)) {
    return { category: 'PRODUCT', reason: 'product_contact' };
  }
  if (/เบอร์.*บริษัท|ช่องทางติดต่อบริษัท|ที่อยู่.*บริษัท|ใบกำกับภาษี/.test(current)) {
    return { category: 'HR', reason: 'company_information' };
  }
  // GENERAL can use conversation context and ask a focused question itself.
  // A router's broad clarification flag must not suppress already-clear work help.
  if (route.category === 'GENERAL') return {category:'GENERAL',reason:'general_contextual_answer'};
  if (route.needsClarification) return {
    category: route.category, reason: 'router_requested_clarification',
    clarification: 'ต้องการทราบเรื่องไหนหรือทำขั้นตอนไหนในระบบใดครับ? ระบุเพิ่มสั้น ๆ ได้เลยครับ',
  };
  return { category: route.category, reason: 'model_route' };
}
