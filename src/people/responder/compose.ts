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

export function buildComposeUserMessage(results: readonly SearchResult[], query: string): string {
  return (
    `คำถามผู้ใช้: ${query}\n\n` +
    `FACTS (ใช้ได้เฉพาะข้อมูลด้านล่างนี้เท่านั้น):\n${serializeFacts(results)}\n\n` +
    `เรียบเรียงคำตอบสั้น ๆ เป็นมิตร ภาษาไทย ลงท้าย "ครับ" — ` +
    `ห้ามเพิ่มชื่อบุคคล อีเมล หรือคุณสมบัติใด ๆ ที่ไม่มีใน FACTS เด็ดขาด`
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

export interface ComposeInput {
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

export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const { results, query, llm, knownNames = [] } = input;
  if (results.length === 0) return { text: templateFallback([]), usedFallback: true, reason: "no_results" };

  let output = "";
  try {
    output = (await llm(buildComposeUserMessage(results, query))).trim();
  } catch {
    output = "";
  }
  if (!output) return { text: templateFallback(results), usedFallback: true, reason: "empty" };

  const check = postCheck(output, results, knownNames);
  if (!check.ok) return { text: templateFallback(results), usedFallback: true, reason: check.reason };
  return { text: output, usedFallback: false };
}
