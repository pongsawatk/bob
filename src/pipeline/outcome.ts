/** These patterns only identify previously observed mismatches in the rendered
 * People templates. Absence of a signal is not a quality verdict. */
export function classifyAnswerShape(question: string, answer: string, intent: string): string | undefined {
  if (intent !== 'PEOPLE') return;
  const excludesNames = /ไม่(?:เอา|ต้อง(?:ส่ง|แสดง)?)รายชื่อ/.test(question);
  const asksForCounts = /(?:จำนวน|กี่คน).*(?:ต่อตำแหน่ง|แยกตามตำแหน่ง)|เฉพาะตัวเลข/.test(question);
  const countOnly = excludesNames || (asksForCounts && !question.includes('รายชื่อ'));
  if (countOnly && /^\s*\d+\.\s+.+?\s—\s/m.test(answer)) return 'roster_instead_of_counts';
  if (/อายุ(?:เท่าไหร่|เท่าไร|กี่ปี)/.test(question) && !question.includes('อายุงาน') && /อายุงาน\s*\(ปี\)\s*:/.test(answer)) return 'tenure_instead_of_age';
  if (/ลาออก|ยังทำงานอยู่|สถานะการจ้าง/.test(question) && /—\s*วันเริ่มงาน:/.test(answer) && !/ลาออก|ยังทำงาน|สถานะการจ้าง/.test(answer)) return 'start_date_instead_of_status';
}

/** Operational labels, not an automated claim of factual correctness. */
export type AnswerStatus = 'answered' | 'clarification' | 'no_information' | 'partial' | 'refused' | 'failed' | 'unknown';
export function domainOutcome(text: string, category: string) {
  if (!text.trim()) return { answerStatus: 'failed', outcomeSource: 'deterministic' };
  if (category === 'UNKNOWN') return { answerStatus: /ไม่(?:ให้|เปิดเผย|สามารถ.*(?:ส่ง|เข้าถึง|เปิดเผย))|ไม่มีสิทธิ/.test(text)?'refused':'unknown', outcomeSource:'text_heuristic',reviewRequired:true };
  const missing = /ไม่มีข้อมูล|ไม่พบข้อมูล|ยังไม่พบ|ยังไม่มีข้อมูล|ไม่สามารถตรวจสอบ|ไม่สามารถดึง/;
  // A review queue signal only. Human reviewers determine whether the referral is appropriate.
  return { answerStatus: missing.test(text) ? 'no_information' : 'answered', outcomeSource: 'text_heuristic', reviewRequired: missing.test(text) };
}
export function peopleOutcome(res: { errorStage?: string; partialGroups?: boolean; text?: string }, question?: string) {
  const stage = res.errorStage;
  const mismatch = question && res.text ? classifyAnswerShape(question, res.text, 'PEOPLE') : undefined;
  if (mismatch) return { answerStatus: 'partial', outcomeSource: 'text_heuristic', reviewRequired: true, reviewReason: mismatch };
  const answerStatus: AnswerStatus = res.partialGroups ? 'partial'
    : stage === 'POLICY_REFUSE' ? 'refused'
    : stage === 'NEEDS_CLARIFICATION' || stage === 'POLICY_CLARIFY' ? 'clarification'
    : stage === 'INTENT_FALLBACK' || stage === 'IDENTITY' ? 'failed'
    : stage === 'NO_RESULT' || stage === 'NO_SUPERVISOR' ? 'no_information' : 'answered';
  return { answerStatus, outcomeSource: 'deterministic', reviewRequired: stage === 'RESPONDER_VALIDATION_FAILED' };
}
