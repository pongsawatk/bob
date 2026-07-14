// People Connector — response composer (plan §6, WP-22.2). The SECOND LLM
// touchpoint: it may only rephrase the approved FACTS from retrieval — never add
// a person, email, or attribute. A deterministic post-check enforces that: every
// email in the output must belong to the result set, and no other directory
// person may appear. On any violation (or empty/error) we discard the LLM text
// and fall back to a plain template built directly from the facts. The LLM is
// injected (LlmCall) for testability.

import type { LlmCall } from "../intent/extract.js";
import type { RelationshipType } from "../pcTypes.js";
import type { SearchResult } from "../retrieval/rank.js";

const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

const REL_TH: Record<RelationshipType, string> = {
  OWNER: "ผู้ดูแล",
  EXPERT: "ผู้เชี่ยวชาญ",
  EXPERIENCED: "เคยทำงานที่เกี่ยวข้อง",
  OPEN_TO_DISCUSS: "ยินดีแลกเปลี่ยน",
  CONTACT_POINT: "จุดติดต่อ",
};

const REASON_TH: Record<string, string> = {
  nickname_match: "ตรงกับชื่อที่ค้นหา",
  name_match: "ตรงกับชื่อที่ค้นหา",
  team_member: "อยู่ในทีมนี้",
  supervisor: "หัวหน้าโดยตรง",
};

const whyOf = (r: SearchResult): string =>
  r.kind === "tagged" ? `${REL_TH[r.relationshipType]} (${r.matchedTag})` : REASON_TH[r.reasonCode] ?? "";

/** Serialized approved facts handed to the LLM — allowed fields only, no personId. */
export function serializeFacts(results: readonly SearchResult[]): string {
  return results
    .map((r, i) => {
      const p = r.profile;
      const parts = [
        `#${i + 1}`,
        `ชื่อ: ${p.displayName}${p.nickname ? ` (${p.nickname})` : ""}`,
        p.position ? `ตำแหน่ง: ${p.position}` : "",
        [p.subOrg, p.functionTeam].filter(Boolean).length ? `ทีม: ${[p.subOrg, p.functionTeam].filter(Boolean).join(" / ")}` : "",
        p.email ? `email: ${p.email}` : "",
        p.tenureYears != null ? `อายุงาน: ${p.tenureYears} ปี ${p.tenureMonths ?? 0} เดือน` : "",
        `เหตุผล: ${whyOf(r)}`,
      ].filter(Boolean);
      return parts.join(" | ");
    })
    .join("\n");
}

export function buildComposeUserMessage(
  results: readonly SearchResult[],
  query: string,
  ctx?: Pick<ResponseContext, "totalMatches" | "shownCount" | "truncated">,
): string {
  // Tell the model the totals when the page is partial, so it can satisfy the
  // disclosure rule the guard enforces instead of always losing to the template.
  const totals =
    ctx?.truncated
      ? `\nพบทั้งหมด ${ctx.totalMatches} คน แต่ FACTS ด้านล่างมีเพียง ${ctx.shownCount} คนแรก — ` +
        `คำตอบต้องบอกทั้งจำนวนทั้งหมด (${ctx.totalMatches}) และจำนวนที่แสดง (${ctx.shownCount}) ให้ชัดเจน\n`
      : "";
  return (
    `คำถามผู้ใช้: ${query}\n${totals}\n` +
    `FACTS (ใช้ได้เฉพาะข้อมูลด้านล่างนี้เท่านั้น):\n${serializeFacts(results)}\n\n` +
    `เรียบเรียงคำตอบสั้น ๆ เป็นมิตร ภาษาไทย ลงท้าย "ครับ" — ` +
    `ห้ามเพิ่มชื่อบุคคล อีเมล หรือคุณสมบัติใด ๆ ที่ไม่มีใน FACTS เด็ดขาด และห้ามบอกว่าไม่พบข้อมูลเมื่อ FACTS ไม่ว่าง`
  );
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export interface PostCheck {
  ok: boolean;
  reason?: string;
}

/** Deterministic guard: reject output that introduces an email outside the result
 *  set, or names a directory person who isn't in it (knownNames = all directory
 *  display names + nicknames). This is the real privacy guarantee — not the prompt. */
export function postCheck(output: string, results: readonly SearchResult[], knownNames: readonly string[] = []): PostCheck {
  const allowedEmails = new Set(results.map((r) => r.profile.email?.toLowerCase()).filter(Boolean) as string[]);
  for (const m of output.matchAll(EMAIL_RE)) {
    if (!allowedEmails.has(m[0].toLowerCase())) return { ok: false, reason: `leaked_email:${m[0]}` };
  }
  const allowedNames = new Set<string>();
  for (const r of results) {
    if (r.profile.displayName) allowedNames.add(norm(r.profile.displayName));
    if (r.profile.nickname) allowedNames.add(norm(r.profile.nickname));
  }
  const outN = norm(output);
  for (const name of knownNames) {
    const n = norm(name);
    if (n.length >= 2 && !allowedNames.has(n) && outN.includes(n)) return { ok: false, reason: "leaked_name" };
  }
  return { ok: true };
}

// ── WP-03: the response guard ────────────────────────────────────────────
//
// postCheck above guards the ADDITIVE direction only — names/emails the model
// invented. The production failures were the other two directions: denying results
// retrieval had found, and quietly presenting a truncated page as the whole answer.
// Retrieval is the source of truth; anything the model says that contradicts it is
// discarded in favour of a template.

/** Everything the guard needs to judge an answer against the retrieval result. */
export interface ResponseContext {
  results: readonly SearchResult[];
  knownNames?: readonly string[];
  totalMatches: number;
  shownCount: number;
  truncated: boolean;
  countOnly: boolean;
  filtersApplied?: { team?: string; bu?: string; role?: string; topic?: string; personRef?: string };
}

/** Phrases that assert "nothing found". Deliberately broad: a false positive costs a
 *  template instead of prose, while a false negative ships a lie. */
const NO_RESULT_RE =
  /ไม่พบ|ไม่เจอ|ยังไม่มีข้อมูล|ไม่มีข้อมูล|ไม่มีใคร|ไม่มีทีม|no (?:results?|matches?|one)\b|not found|(?:could ?n[o']t|can ?n[o']t|unable to) find/i;

/** Every integer in the text, for the count/truncation checks. */
const numbersIn = (s: string): number[] => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));

export function validateResponse(output: string, ctx: ResponseContext): PostCheck {
  const base = postCheck(output, ctx.results, ctx.knownNames ?? []);
  if (!base.ok) return base;

  // Retrieval found people → the answer may not say it found none.
  if (ctx.totalMatches > 0 && NO_RESULT_RE.test(output)) {
    return { ok: false, reason: "no_result_contradiction" };
  }

  // "How many" → the exact number must appear, and no other headcount may.
  if (ctx.countOnly) {
    const nums = numbersIn(output);
    if (!nums.includes(ctx.totalMatches)) return { ok: false, reason: "count_mismatch" };
  }

  // A partial page must say so: both the true total and how many are shown.
  if (ctx.truncated) {
    const nums = numbersIn(output);
    if (!nums.includes(ctx.totalMatches) || !nums.includes(ctx.shownCount)) {
      return { ok: false, reason: "truncation_not_disclosed" };
    }
  }

  return { ok: true };
}

/** Human-readable echo of the filters retrieval actually applied, so the answer
 *  states what was searched rather than leaving the user to guess. */
function filterPhrase(ctx: ResponseContext): string {
  const f = ctx.filtersApplied ?? {};
  const role = f.role ? ROLE_TH[f.role] ?? f.role : "";
  const parts = [f.team ? `ทีม ${f.team}` : "", f.bu ? `หน่วยงาน ${f.bu}` : "", role ? `ตำแหน่ง ${role}` : ""].filter(Boolean);
  return parts.join(" · ");
}

/** Canonical role → Thai label for display. Unknown canon falls through as-is. */
const ROLE_TH: Record<string, string> = {
  QUALITY_ASSURANCE: "QA",
  PROJECT_COORDINATOR: "Project Coordinator",
  PROJECT_MANAGER: "Project Manager",
  BUSINESS_ANALYST: "Business Analyst",
  DEVELOPER: "Developer",
  DESIGNER: "Designer",
  ACCOUNTANT: "บัญชี",
  SALES: "ฝ่ายขาย",
  MARKETING: "การตลาด",
  HUMAN_RESOURCES: "ทรัพยากรบุคคล",
};

/** Deterministic answer for a "how many" question — the count comes from retrieval,
 *  never from a model. */
export function countTemplate(ctx: ResponseContext): string {
  const what = filterPhrase(ctx);
  return `${what ? `${what} ` : ""}มีทั้งหมด ${ctx.totalMatches} คนครับ`;
}

/** Deterministic roster answer. Discloses total vs shown whenever the page is
 *  partial — the "พบ 20 คน" (of 29) failure is impossible to express here. */
export function rosterTemplate(ctx: ResponseContext): string {
  if (ctx.totalMatches === 0) return templateFallback([]);
  const what = filterPhrase(ctx);
  const head = ctx.truncated
    ? `${what ? `${what} — ` : ""}พบทั้งหมด ${ctx.totalMatches} คนครับ แสดง ${ctx.shownCount} คนแรก:`
    : `${what ? `${what} — ` : ""}พบ ${ctx.totalMatches} คนครับ:`;
  const lines = ctx.results.map((r, i) => {
    const p = r.profile;
    const who = `${p.displayName}${p.nickname ? ` (${p.nickname})` : ""}`;
    const role = [p.position, p.functionTeam || p.subOrg].filter(Boolean).join(" · ");
    return `${i + 1}. ${who}${role ? ` — ${role}` : ""}${p.email ? ` — ${p.email}` : ""}`;
  });
  const more = ctx.truncated ? `\n\nพิมพ์ "ดูต่อ" เพื่อดูรายชื่อถัดไปครับ` : "";
  return `${head}\n${lines.join("\n")}${more}`;
}

/** Plain, safe answer built straight from the facts (no LLM). */
export function templateFallback(results: readonly SearchResult[]): string {
  if (results.length === 0) {
    return "ขออภัยครับ ตอนนี้ผมยังไม่พบคนที่ตรงกับที่ถามมา 🙏 ลองระบุทีมหรือหัวข้อให้ชัดขึ้น หรือสอบถาม HR ได้เลยนะครับ";
  }
  const lines = results.map((r, i) => {
    const p = r.profile;
    const who = `${p.displayName}${p.nickname ? ` (${p.nickname})` : ""}`;
    const role = [p.position, p.functionTeam || p.subOrg].filter(Boolean).join(" · ");
    const why = whyOf(r);
    const contact = p.email ? ` — ${p.email}` : "";
    return `${i + 1}. ${who}${role ? ` — ${role}` : ""}${why ? ` — ${why}` : ""}${contact}`;
  });
  return `พบ ${results.length} คนที่เกี่ยวข้องครับ:\n${lines.join("\n")}`;
}

export interface ComposeInput extends ResponseContext {
  results: SearchResult[];
  query: string;
  llm: LlmCall;
  /** all directory display names + nicknames, for the leak check. */
  knownNames?: string[];
}

export interface ComposeResult {
  text: string;
  usedFallback: boolean;
  reason?: string;
}

/** The deterministic answer for a context — what the LLM is measured against and
 *  what we ship when it fails. */
export function deterministicAnswer(ctx: ResponseContext): string {
  if (ctx.countOnly) return countTemplate(ctx);
  return rosterTemplate(ctx);
}

export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const { results, query, llm } = input;
  if (input.countOnly) {
    // A count needs no prose and no model call: retrieval already has the answer.
    return { text: countTemplate(input), usedFallback: false, reason: "deterministic_count" };
  }
  if (results.length === 0) return { text: templateFallback([]), usedFallback: true, reason: "no_results" };

  let output = "";
  try {
    output = (await llm(buildComposeUserMessage(results, query, input))).trim();
  } catch {
    output = "";
  }
  if (!output) return { text: deterministicAnswer(input), usedFallback: true, reason: "empty" };

  const check = validateResponse(output, input);
  if (!check.ok) {
    // Reason code only — never the query, the answer, or any roster row.
    console.warn(`RESPONDER_VALIDATION_FAILED: ${check.reason}`);
    return { text: deterministicAnswer(input), usedFallback: true, reason: check.reason };
  }
  return { text: output, usedFallback: false };
}
