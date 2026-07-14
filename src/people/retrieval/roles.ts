// People Connector — canonical role taxonomy (WP-02). Deterministic and versioned
// in code, deliberately NOT in a prompt: the LLM extracts the words the user typed,
// this maps them to a concept and decides which positions satisfy it. Keeping it
// here means a wrong mapping is a test away from being caught, not a prompt reroll.
//
// Scope is roles/positions only. Team/BU/org aliases ("ทีมบัญชี", "PJM") are a
// different concern and live in the alias layer.

/** Concepts a role filter can resolve to. Extend by adding aliases below. */
export const CANONICAL_ROLES = [
  "QUALITY_ASSURANCE",
  "PROJECT_COORDINATOR",
  "PROJECT_MANAGER",
  "BUSINESS_ANALYST",
  "DEVELOPER",
  "DESIGNER",
  "ACCOUNTANT",
  "SALES",
  "MARKETING",
  "HUMAN_RESOURCES",
] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

/** Surface forms per concept, Thai + English + abbreviations. Order within a list
 *  is irrelevant; across concepts, the FIRST concept with a match wins, so keep
 *  narrow concepts above broad ones where they could overlap (QA before DEVELOPER:
 *  a "QA Engineer" is not a Developer). */
const ROLE_ALIASES: Record<CanonicalRole, string[]> = {
  QUALITY_ASSURANCE: ["quality assurance", "qa engineer", "software tester", "tester", "qa", "ผู้ทดสอบ", "ทดสอบระบบ", "ประกันคุณภาพ"],
  PROJECT_COORDINATOR: ["project coordinator", "ผู้ประสานงานโครงการ", "ประสานงานโครงการ"],
  PROJECT_MANAGER: ["project manager", "ผู้จัดการโครงการ"],
  BUSINESS_ANALYST: ["business analyst", "นักวิเคราะห์ธุรกิจ", "วิเคราะห์ธุรกิจ"],
  DEVELOPER: ["software engineer", "developer", "programmer", "นักพัฒนา", "โปรแกรมเมอร์"],
  DESIGNER: ["ux/ui", "ui/ux", "designer", "นักออกแบบ", "ออกแบบ"],
  ACCOUNTANT: ["accountant", "accounting", "เจ้าหน้าที่บัญชี", "บัญชี"],
  SALES: ["sales", "พนักงานขาย", "ฝ่ายขาย"],
  MARKETING: ["marketing", "การตลาด"],
  HUMAN_RESOURCES: ["human resources", "hr", "ทรัพยากรบุคคล"],
};

const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Short ASCII aliases ("qa", "hr") need word boundaries so they can't fire inside
 *  an unrelated word; longer/Thai forms are matched as plain substrings. */
function aliasIn(haystack: string, alias: string): boolean {
  if (alias.length <= 3 && /^[a-z0-9]+$/.test(alias)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(alias)}([^a-z0-9]|$)`).test(haystack);
  }
  return haystack.includes(alias);
}

/**
 * Map a free-text role the user typed onto a concept, or null when we don't
 * recognize it. Null is a real answer — callers must still apply the raw text as a
 * filter rather than drop the constraint (dropping it is what caused P0-2).
 */
export function canonicalRole(raw: string): CanonicalRole | null {
  const n = norm(raw);
  if (!n) return null;
  for (const role of CANONICAL_ROLES) {
    if (ROLE_ALIASES[role].some((a) => norm(a) === n)) return role;
  }
  for (const role of CANONICAL_ROLES) {
    if (ROLE_ALIASES[role].some((a) => aliasIn(n, norm(a)))) return role;
  }
  return null;
}

/** Does a directory `position` cell satisfy a canonical role? */
export function roleMatchesPosition(position: string | undefined, role: CanonicalRole): boolean {
  const p = norm(position);
  if (!p) return false;
  // A position that reads as a narrower concept must not also satisfy a broader one
  // ("QA Engineer" contains "engineer" but is not a DEVELOPER).
  for (const r of CANONICAL_ROLES) {
    if (ROLE_ALIASES[r].some((a) => aliasIn(p, norm(a)))) return r === role;
  }
  return false;
}

/** Filter predicate for a role the taxonomy doesn't know: plain normalized
 *  substring on the position cell, so the constraint still narrows the set. */
export function rawRoleMatchesPosition(position: string | undefined, raw: string): boolean {
  const n = norm(raw);
  return n.length > 0 && norm(position).includes(n);
}
