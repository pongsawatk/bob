import { canonicalQuery, retrievalQuery, type QueryTurn } from '../kb/query.js';
import type { RouterResult } from './router.js';

export interface RouteDecision { category: RouterResult['category']; clarification?: string; reason: string }
export function decideRoute(route: Pick<RouterResult, 'category' | 'needsClarification'>, question: string, history: readonly QueryTurn[] = []): RouteDecision {
  // Never turn an unsafe/unknown route into an allowed domain via a keyword hit.
  if (route.category === 'UNKNOWN') return { category: 'UNKNOWN', reason: 'unknown_route' };
  const q = retrievalQuery(question, history);
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
