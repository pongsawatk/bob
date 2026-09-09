/** Operational labels, not an automated claim of factual correctness. */
export type AnswerStatus = 'answered' | 'clarification' | 'no_information' | 'partial' | 'refused' | 'failed' | 'unknown';
export function domainOutcome(text: string, category: string) {
  if (!text.trim()) return { answerStatus: 'failed', outcomeSource: 'deterministic' };
  if (category === 'UNKNOWN') return { answerStatus: 'clarification', outcomeSource: 'router' };
  const missing = /ไม่มีข้อมูล|ไม่พบข้อมูล|ยังไม่พบ|ยังไม่มีข้อมูล|ไม่สามารถตรวจสอบ|ไม่สามารถดึง/;
  // A review queue signal only. Human reviewers determine whether the referral is appropriate.
  return { answerStatus: missing.test(text) ? 'no_information' : 'answered', outcomeSource: 'text_heuristic', reviewRequired: missing.test(text) };
}
export function peopleOutcome(res: { errorStage?: string; partialGroups?: boolean }) {
  const stage = res.errorStage;
  const answerStatus: AnswerStatus = res.partialGroups ? 'partial'
    : stage === 'POLICY_REFUSE' ? 'refused'
    : stage === 'NEEDS_CLARIFICATION' || stage === 'POLICY_CLARIFY' ? 'clarification'
    : stage === 'INTENT_FALLBACK' || stage === 'IDENTITY' ? 'failed'
    : stage === 'NO_RESULT' || stage === 'NO_SUPERVISOR' ? 'no_information' : 'answered';
  return { answerStatus, outcomeSource: 'deterministic', reviewRequired: stage === 'RESPONDER_VALIDATION_FAILED' };
}
