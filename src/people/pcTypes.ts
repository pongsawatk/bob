// People Connector — shared contracts (plan §2, §4, §5, §6). Kept as TS unions +
// hand-written validators to match the repo idiom (see analytics/report.ts). The
// LLM boundary (intent extraction) validates against these; everything downstream
// is deterministic.

/** The sub-intents from the main plan §2, plus TENURE (WP-01: "ฉันทำงานมากี่ปีแล้ว"
 *  is a distinct question from PERSON_LOOKUP — it wants one computed fact, not a
 *  profile). Adding a value here is safe for `/insight`: analytics normalizes the
 *  router *category* (HR/PRODUCT/GENERAL/PEOPLE/UNKNOWN), never these. */
export const SUB_INTENTS = [
  "OWNER_LOOKUP",
  "EXPERT_FIND",
  "IDEA_CONNECT",
  "EXPERIENCE_FIND",
  "TEAM_DISCOVERY",
  "PERSON_LOOKUP",
  "TEAM_ROSTER",
  "REPORTING_LINE",
  "TENURE",
  "CONTACT_HELP",
  "FOLLOW_UP_FILTER",
  "CORRECTION",
] as const;
export type SubIntent = (typeof SUB_INTENTS)[number];

/** Who the question is about. Resolved deterministically (see intent/extract.ts
 *  #detectSelfReference) — the LLM may propose it, but code decides, because a wrong
 *  SELF/NAMED_PERSON call is an identity bug, not a phrasing one. */
export const TARGET_TYPES = ["SELF", "NAMED_PERSON", "TEAM", "UNKNOWN"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/** Sub-intents answerable from directory data we already have live (plan §10 MVP).
 *  The rest need approved tags (owner/expertise/open-to-discuss) → gated on G0. */
export const DIRECTORY_INTENTS: ReadonlySet<SubIntent> = new Set<SubIntent>([
  "TEAM_DISCOVERY",
  "PERSON_LOOKUP",
  "TEAM_ROSTER",
  "REPORTING_LINE",
  "TENURE",
  "CONTACT_HELP",
  "FOLLOW_UP_FILTER",
  "CORRECTION",
]);

/** The 5 relationship types from §4 — must never be blended in output. */
export const RELATIONSHIP_TYPES = ["OWNER", "EXPERT", "EXPERIENCED", "OPEN_TO_DISCUSS", "CONTACT_POINT"] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Deterministic policy gate verdicts (§6). */
export type PolicyOutcome = "ALLOW" | "CLARIFY" | "REFUSE" | "UNABLE_TO_DETERMINE";

export interface SearchParams {
  /** the subject/topic being asked about (free text, e.g. "Pojjaman", "Power BI"). */
  topic?: string;
  /** an explicitly named team / sub-org. */
  team?: string;
  /** an explicitly named business unit / org. */
  bu?: string;
  /** a person referenced by name or nickname (NOT resolved by the LLM). */
  personRef?: string;
  /** a role/position constraint as the user typed it, e.g. "QA", "tester",
   *  "Project Coordinator". Canonicalized deterministically by retrieval/roles.ts —
   *  the LLM must not map it itself. ANDed with team/bu; never dropped (WP-02). */
  role?: string;
}

/** Output of intent extraction (§6). The LLM returns ONLY this — never names,
 *  expertise, or relationships. */
export interface IntentResult {
  subIntent: SubIntent;
  searchParams: SearchParams;
  confidence: number;
  /** the user asked "how many", not "who" → answer the exact deterministic count
   *  and ship no roster to the responder (WP-02). */
  countOnly?: boolean;
  /** who the question is about (WP-01). Absent = legacy/unknown; retrieval treats
   *  it as NAMED_PERSON/TEAM exactly as before. */
  targetType?: TargetType;
  /** set by the extractor (never by the LLM) when both attempts failed and this is
   *  the confidence-0 fallback — so telemetry can tell "the model couldn't parse the
   *  question" apart from "the question genuinely had no answer" (WP-07). */
  extractionFallback?: boolean;
}

/** Serving-facing profile view (§5). Directory layer is live now; tag arrays stay
 *  empty until G0. There is deliberately no personId/payroll id — directory.ts
 *  never imports one, so the plan's "strip technical id" concern is moot here. */
export interface WorkProfile {
  displayName: string;
  nickname?: string;
  email?: string;
  org?: string;
  subOrg?: string;
  position?: string;
  functionTeam?: string;
  supervisor?: string;
  startDate?: string;
  tenureYears?: number;
  tenureMonths?: number;
  // Tags layer — G0-gated, empty until HR/Data Owner approves + populates.
  ownershipTags?: string[];
  expertiseTags?: string[];
  openToDiscussTags?: string[];
  contactPreference?: "teams" | "email";
  tagsConfirmedAt?: string | null;
}

/** Fields a caller may request back. Anything outside this set → policy REFUSE.
 *  Excludes rank, payroll id, prefix, and every sensitive attribute (§5, §8). */
export const ALLOWLIST_FIELDS: ReadonlySet<string> = new Set([
  "displayName",
  "nickname",
  "email",
  "org",
  "subOrg",
  "position",
  "functionTeam",
  "supervisor",
  "startDate",
  "tenureYears",
  "tenureMonths",
  "ownershipTags",
  "expertiseTags",
  "openToDiscussTags",
  "contactPreference",
  "relationshipType",
  "reason",
]);

export const isSubIntent = (x: unknown): x is SubIntent =>
  typeof x === "string" && (SUB_INTENTS as readonly string[]).includes(x);

/** Validate a parsed LLM intent object. Returns [] when valid, else error strings
 *  (used by the extractor's retry-then-downgrade logic). */
export function validateIntentResult(x: unknown): string[] {
  const e: string[] = [];
  if (typeof x !== "object" || x === null) return ["intentResult must be an object"];
  const o = x as Record<string, unknown>;
  if (!isSubIntent(o.subIntent)) e.push("subIntent must be one of SUB_INTENTS");
  if (typeof o.confidence !== "number" || !(o.confidence >= 0 && o.confidence <= 1))
    e.push("confidence must be a number in [0,1]");
  if (o.countOnly !== undefined && typeof o.countOnly !== "boolean") e.push("countOnly must be a boolean");
  if (o.targetType !== undefined && !(TARGET_TYPES as readonly string[]).includes(o.targetType as string))
    e.push("targetType must be one of TARGET_TYPES");
  const sp = o.searchParams;
  if (typeof sp !== "object" || sp === null) {
    e.push("searchParams must be an object");
  } else {
    for (const [k, v] of Object.entries(sp as Record<string, unknown>)) {
      if (!["topic", "team", "bu", "personRef", "role"].includes(k)) e.push(`searchParams has unexpected key: ${k}`);
      else if (v !== undefined && typeof v !== "string") e.push(`searchParams.${k} must be a string`);
    }
  }
  return e;
}
