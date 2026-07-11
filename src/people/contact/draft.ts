// People Connector — contact draft (plan §7, WP-22.3). Produces TEXT the user
// reviews, edits, and sends THEMSELVES. There is deliberately no send capability
// in the MVP — this module must never import a Teams/bot sender (a test asserts
// that). The LLM (optional) only personalizes wording; the template already works.

import type { LlmCall } from "../intent/extract.js";
import type { SearchResult } from "../retrieval/rank.js";

export interface ContactDraftInput {
  /** the approved person to reach out to. */
  target: SearchResult;
  /** what the user wants to discuss (usually searchParams.topic). */
  topic: string;
  /** the asker's own name/nickname for a natural intro (optional). */
  askerName?: string;
  /** optional wording polish; falls back to the template on error/empty. */
  llm?: LlmCall;
}

export interface ContactDraft {
  draft: string;
}

/** Deterministic baseline draft — always safe, no LLM. */
export function templateDraft(target: SearchResult, topic: string, askerName?: string): string {
  const to = target.profile.nickname || target.profile.displayName;
  const intro = askerName ? `ผม ${askerName} ` : "";
  const subject = topic.trim() || "เรื่องงานที่เกี่ยวข้อง";
  return (
    `สวัสดีครับพี่${to} ${intro}กำลังศึกษาเรื่อง ${subject} ` +
    `เห็นว่าพี่ดูแล/เกี่ยวข้องกับเรื่องนี้ เลยอยากขอเวลาปรึกษาแนวทางเบื้องต้นสักเล็กน้อยครับ ` +
    `ไม่ทราบว่าสะดวกช่วงไหนดีครับ 🙏`
  );
}

function buildDraftUserMessage(base: string, input: ContactDraftInput): string {
  return (
    `ช่วยปรับข้อความทักทายนี้ให้เป็นธรรมชาติขึ้นเล็กน้อย โดยคงหัวข้อ "${input.topic}" ไว้ ` +
    `และคงไว้เป็น "ร่าง" ให้ผู้ใช้ตรวจก่อนส่งเอง — ห้ามเพิ่มชื่อบุคคลอื่น:\n\n${base}`
  );
}

export async function draftContact(input: ContactDraftInput): Promise<ContactDraft> {
  const base = templateDraft(input.target, input.topic, input.askerName);
  if (!input.llm) return { draft: base };
  try {
    const polished = (await input.llm(buildDraftUserMessage(base, input))).trim();
    return { draft: polished || base };
  } catch {
    return { draft: base };
  }
}
