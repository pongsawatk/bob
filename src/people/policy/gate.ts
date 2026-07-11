// People Connector — deterministic policy gate (plan §6, §8, §11). A PURE function
// that inspects the raw query text + requested fields for privacy/abuse BEFORE
// looking at confidence. No LLM, no data access. This is the privacy boundary:
// the retrieval/responder layers trust its verdict.

import { ALLOWLIST_FIELDS, type PolicyOutcome, type SubIntent } from "../pcTypes.js";
import { PC_CONFIG } from "../pcConfig.js";
import { BLOCKED_CATEGORIES, INJECTION_PATTERNS } from "./blockedTopics.js";

export interface PolicyInput {
  /** the original user text (not the LLM's paraphrase). */
  queryText: string;
  intentResult: { subIntent: SubIntent; confidence: number };
  /** fields the caller wants back, if constrained; each must be in the allowlist. */
  requestedFields?: string[];
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** machine-readable code for audit, e.g. "blocked:salary", "injection",
   *  "field:rank", "ok", "mid_confidence", "low_confidence". Never contains PII. */
  reason: string;
}

const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase();

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const q = norm(input.queryText);

  // 1) Requested fields must be inside the allowlist (checked before confidence).
  for (const f of input.requestedFields ?? []) {
    if (!ALLOWLIST_FIELDS.has(f)) return { outcome: "REFUSE", reason: `field:${f}` };
  }

  // 2) Prompt injection.
  if (INJECTION_PATTERNS.some((re) => re.test(q))) return { outcome: "REFUSE", reason: "injection" };

  // 3) Blocked topics (salary/leave/health/eval/ranking/attrition/enumeration/private/field).
  for (const c of BLOCKED_CATEGORIES) {
    if (c.re.test(q)) return { outcome: "REFUSE", reason: `blocked:${c.code}` };
  }

  // 4) Confidence-driven outcome — only reached when nothing is blocked.
  const conf = input.intentResult.confidence;
  if (conf >= PC_CONFIG.CONFIDENCE_HIGH) return { outcome: "ALLOW", reason: "ok" };
  if (conf >= PC_CONFIG.CONFIDENCE_MID) return { outcome: "CLARIFY", reason: "mid_confidence" };
  return { outcome: "UNABLE_TO_DETERMINE", reason: "low_confidence" };
}
