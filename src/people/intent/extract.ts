// People Connector — intent extraction (plan §2, §6, WP-21.1). The FIRST of the
// two LLM touchpoints (the other is the responder). The LLM does ONE job: map a
// natural-language message to { subIntent, searchParams, confidence }. It must
// never invent people, expertise, or relationships — personRef only carries a
// name/nickname the user actually typed; everything else is resolved downstream
// by deterministic retrieval.
//
// The LLM call is injected (LlmCall) so this is unit-testable with a mock, and so
// the model/prompt wiring lives at the call site (router integration, gated on
// G0). Bad/short JSON → retry once → fall back to confidence 0 (the policy gate
// then returns UNABLE_TO_DETERMINE and BOB asks to clarify — never guesses).

import { extractJson } from "../../analytics/analyze.js";
import { validateIntentResult, type IntentResult, type SearchParams, type TargetType } from "../pcTypes.js";

export type LlmCall = (userContent: string) => Promise<string>;

// ── Self-reference detection (WP-01) ────────────────────────────────────
//
// Deterministic on purpose. The LLM is asked to set targetType too, but code
// decides: mistaking "หัวหน้าฉัน" for a named person is what produced rc=0 on the
// broadcast CTA for every user who tried it, and the inverse mistake would answer
// one employee's question with another employee's reporting line.

/** Thai first-person pronouns. Matched as plain substrings because Thai is written
 *  without spaces — "หัวหน้าฉัน" has no boundary before "ฉัน", and requiring one is why
 *  the obvious phrasing of the broadcast CTA read as "not self". */
const SELF_TH_RE = /ฉัน|ผม|ดิฉัน|กระผม|หนู|เรา|ตัวเอง/;

/** English needs the opposite treatment: word boundaries, or "i" fires inside every
 *  other word. */
const SELF_EN_RE = /(?:^|\W)(?:my|me|mine|myself|i|i'm|i am)(?:$|\W)/i;

/**
 * Does this message ask about the person sending it?
 *
 * A typed name wins: "หัวหน้าของพี่จ้อ" is about พี่จ้อ even if the sentence also says
 * "ผม". Callers pass the extracted personRef so that check stays in one place.
 */
export function detectSelfReference(query: string, personRef?: string): boolean {
  if (personRef && personRef.trim()) return false;
  const q = String(query ?? "");
  return SELF_TH_RE.test(q) || SELF_EN_RE.test(q);
}

/** Decide targetType from the query + extracted params. Code is the authority; an
 *  LLM-proposed value is only consulted for the TEAM/NAMED_PERSON distinction. */
export function resolveTargetType(query: string, sp: SearchParams, proposed?: TargetType): TargetType {
  if (detectSelfReference(query, sp.personRef)) return "SELF";
  if (sp.personRef?.trim()) return "NAMED_PERSON";
  if (sp.team?.trim() || sp.bu?.trim() || sp.role?.trim()) return "TEAM";
  return proposed && proposed !== "SELF" ? proposed : "UNKNOWN";
}

/** Editable in Langfuse at go-live; inline for now since the feature isn't wired. */
export const INTENT_SYSTEM_PROMPT = `คุณคือตัวแยกเจตนา (intent classifier) ของ BOB People Connector
หน้าที่: อ่านข้อความผู้ใช้แล้วแยกว่าเป็น sub-intent ใด และดึง search parameters ออกมา — เท่านั้น
ห้ามเดา/แต่งชื่อคน ความเชี่ยวชาญ ทีม หรือความสัมพันธ์ใด ๆ (ระบบอื่นจะไปค้นจากทะเบียนจริงเอง)
personRef ให้ใส่เฉพาะชื่อ/ชื่อเล่นที่ผู้ใช้พิมพ์มาเองเท่านั้น

sub-intent (เลือก 1 ค่าเป๊ะ):
- OWNER_LOOKUP: หาผู้รับผิดชอบอย่างเป็นทางการ ("ใครดูแล X")
- EXPERT_FIND: หาผู้เชี่ยวชาญทักษะ/เครื่องมือ ("ใครรู้เรื่อง X")
- IDEA_CONNECT: หาคนไว้ระดมความคิด ("อยากคุยเรื่อง X")
- EXPERIENCE_FIND: หาคน/ทีมที่เคยทำงานลักษณะเดียวกัน ("ใครเคยทำ X")
- TEAM_DISCOVERY: ยังไม่รู้คน ถามว่าควรเริ่มที่ทีมไหน ("เรื่อง X ควรถามทีมไหน")
- PERSON_LOOKUP: ข้อมูลงานพื้นฐานของคนที่รู้ชื่อ/ชื่อเล่นแล้ว ("พี่ X อยู่ทีมไหน")
- TEAM_ROSTER: รายชื่อสมาชิกของทีม/BU ที่ระบุชัด ("ทีม X มีใครบ้าง")
- REPORTING_LINE: หัวหน้าโดยตรงของใคร ("หัวหน้าของ X คือใคร")
- TENURE: อายุงาน/ทำงานมานานเท่าไหร่ ("X ทำงานมากี่ปีแล้ว")
- CONTACT_HELP: ขอช่องทาง/ร่างข้อความติดต่อ ("ช่วยร่างข้อความทัก X")
- FOLLOW_UP_FILTER: ปรับผลค้นหาชุดเดิม ("ขอเฉพาะคนใน X" / "มีคนอื่นอีกไหม")
- CORRECTION: แจ้งข้อมูลผิด/ล้าสมัย ("คนนี้เปลี่ยนแล้ว")

searchParams: { topic?, team?, bu?, personRef?, role? } — ใส่เฉพาะที่ระบุจริง ไม่มีก็เว้น
- role: ตำแหน่ง/บทบาทที่ผู้ใช้พิมพ์มา เช่น "QA", "tester", "Project Coordinator" — ใส่ตามที่พิมพ์ ห้ามแปลงเอง (ระบบจะ map เป็นตำแหน่งมาตรฐานเอง)
- ถ้าผู้ใช้ระบุทั้งทีมและตำแหน่ง ต้องใส่ทั้ง team และ role ห้ามทิ้งอันใดอันหนึ่ง
countOnly: true เมื่อผู้ใช้ถามจำนวน ("กี่คน") ไม่ได้ขอรายชื่อ
targetType: "SELF" เมื่อถามถึงตัวผู้ถามเอง (ฉัน/ผม/เรา) · "NAMED_PERSON" เมื่อระบุชื่อคน · "TEAM" เมื่อถามถึงทีม
- ถ้าเป็น SELF ห้ามใส่ personRef เด็ดขาด (ผู้ใช้ไม่ได้พิมพ์ชื่อใคร ระบบรู้ว่าใครถามเอง)
confidence: 0.0–1.0 ตามความมั่นใจ

ตัวอย่าง:
"ใครดูแล Pojjaman" → {"subIntent":"OWNER_LOOKUP","searchParams":{"topic":"Pojjaman"},"confidence":0.9}
"who owns the Builk360 product" → {"subIntent":"OWNER_LOOKUP","searchParams":{"topic":"Builk360"},"confidence":0.88}
"มีใครพอรู้เรื่อง Power BI บ้าง" → {"subIntent":"EXPERT_FIND","searchParams":{"topic":"Power BI"},"confidence":0.85}
"anyone who knows Kubernetes" → {"subIntent":"EXPERT_FIND","searchParams":{"topic":"Kubernetes"},"confidence":0.85}
"อยากคุยเรื่องใช้ AI กับงานขาย" → {"subIntent":"IDEA_CONNECT","searchParams":{"topic":"AI กับงานขาย"},"confidence":0.8}
"ทีมไหนเคยทำ LINE OA มาก่อน" → {"subIntent":"EXPERIENCE_FIND","searchParams":{"topic":"LINE OA"},"confidence":0.8}
"เรื่องประกันกลุ่มควรเริ่มถามทีมไหน" → {"subIntent":"TEAM_DISCOVERY","searchParams":{"topic":"ประกันกลุ่ม"},"confidence":0.8}
"พี่โบ๊ทอยู่ทีมไหน ตำแหน่งอะไร" → {"subIntent":"PERSON_LOOKUP","searchParams":{"personRef":"โบ๊ท"},"confidence":0.9}
"what team is Alice in" → {"subIntent":"PERSON_LOOKUP","searchParams":{"personRef":"Alice"},"confidence":0.88}
"ทีม Jubili มีใครบ้าง" → {"subIntent":"TEAM_ROSTER","searchParams":{"team":"Jubili"},"targetType":"TEAM","confidence":0.9}
"หัวหน้าของพี่จ้อคือใคร" → {"subIntent":"REPORTING_LINE","searchParams":{"personRef":"จ้อ"},"targetType":"NAMED_PERSON","confidence":0.9}
"หัวหน้าฉันคือใคร" → {"subIntent":"REPORTING_LINE","searchParams":{},"targetType":"SELF","confidence":0.95}
"ฉันอยู่ทีมไหน" → {"subIntent":"PERSON_LOOKUP","searchParams":{},"targetType":"SELF","confidence":0.95}
"who is my manager" → {"subIntent":"REPORTING_LINE","searchParams":{},"targetType":"SELF","confidence":0.95}
"ผมทำงานที่นี่มากี่ปีแล้ว" → {"subIntent":"TENURE","searchParams":{},"targetType":"SELF","confidence":0.95}
"ทีมผมมีใครบ้าง" → {"subIntent":"TEAM_ROSTER","searchParams":{},"targetType":"SELF","confidence":0.9}
"ทีม DX มี QA กี่คน" → {"subIntent":"TEAM_ROSTER","searchParams":{"team":"DX","role":"QA"},"targetType":"TEAM","countOnly":true,"confidence":0.9}
"Project Coordinator ทีม DX มีใครบ้าง" → {"subIntent":"TEAM_ROSTER","searchParams":{"team":"DX","role":"Project Coordinator"},"targetType":"TEAM","confidence":0.9}
"ช่วยร่างข้อความทักคนที่ดูแล Pojjaman" → {"subIntent":"CONTACT_HELP","searchParams":{"topic":"Pojjaman"},"confidence":0.85}
"ขอเฉพาะคนใน Contech" → {"subIntent":"FOLLOW_UP_FILTER","searchParams":{"bu":"Contech"},"confidence":0.8}
"มีคนอื่นอีกไหม" → {"subIntent":"FOLLOW_UP_FILTER","searchParams":{},"confidence":0.75}
"ผู้ดูแลคนนี้เปลี่ยนแล้ว" → {"subIntent":"CORRECTION","searchParams":{},"confidence":0.8}`;

const SCHEMA_HINT =
  'ตอบเป็น JSON เท่านั้น (ไม่มีข้อความอื่น): ' +
  '{"subIntent":"<หนึ่งใน sub-intent>","searchParams":{"topic"?,"team"?,"bu"?,"personRef"?,"role"?},' +
  '"targetType":"SELF|NAMED_PERSON|TEAM|UNKNOWN","countOnly":true|false,"confidence":0.0-1.0}';

export interface ExtractOptions {
  /** recent turns for follow-up context (e.g. "มีคนอื่นอีกไหม"). */
  history?: { role: "user" | "assistant"; content: string }[];
}

export function buildUserMessage(query: string, history: ExtractOptions["history"] = []): string {
  const ctx =
    history.length > 0
      ? history
          .slice(-4)
          .map((m) => `${m.role === "user" ? "ผู้ใช้" : "BOB"}: ${m.content}`)
          .join("\n") + "\n\n"
      : "";
  return `${ctx}คำถามล่าสุด: ${query}\n\n${SCHEMA_HINT}`;
}

/** Low-confidence fallback: subIntent is moot once confidence < MID (policy gate
 *  returns UNABLE_TO_DETERMINE → clarify). TEAM_DISCOVERY is the safest neutral. */
export const FALLBACK_INTENT: Readonly<IntentResult> = Object.freeze({
  subIntent: "TEAM_DISCOVERY",
  searchParams: {},
  confidence: 0,
});

const ALLOWED_SP: (keyof SearchParams)[] = ["topic", "team", "bu", "personRef", "role"];

/** Keep only allowed, non-empty string params — so an extra LLM key doesn't fail
 *  validation and force an unnecessary retry. */
function normalizeSearchParams(sp: unknown): SearchParams {
  const out: SearchParams = {};
  if (sp && typeof sp === "object") {
    for (const k of ALLOWED_SP) {
      const v = (sp as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  }
  return out;
}

/** Parse+validate one LLM output → IntentResult, or null if unusable. */
function coerce(parsed: unknown): IntentResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const candidate: IntentResult = {
    subIntent: o.subIntent as IntentResult["subIntent"],
    searchParams: normalizeSearchParams(o.searchParams),
    confidence: typeof o.confidence === "number" ? Math.max(0, Math.min(1, o.confidence)) : Number.NaN,
    ...(typeof o.countOnly === "boolean" ? { countOnly: o.countOnly } : {}),
    ...(typeof o.targetType === "string" ? { targetType: o.targetType as TargetType } : {}),
  };
  return validateIntentResult(candidate).length === 0 ? candidate : null;
}

/** Extract intent with one retry, then fall back to confidence 0. targetType is
 *  always (re)decided in code afterwards — see resolveTargetType. */
export async function extractIntent(query: string, llm: LlmCall, opts: ExtractOptions = {}): Promise<IntentResult> {
  const user = buildUserMessage(query, opts.history);

  const first = coerce(extractJson(await llm(user)));
  if (first) return withTargetType(query, first);

  const retry = coerce(extractJson(await llm(user + "\n\nโปรดตอบเป็น JSON ที่ถูกต้องตาม schema เท่านั้น ไม่มีข้อความอื่น")));
  if (retry) return withTargetType(query, retry);

  return withTargetType(query, { ...FALLBACK_INTENT, searchParams: {}, extractionFallback: true });
}

/** Overwrite whatever the model proposed with the deterministic verdict, and drop a
 *  personRef the model invented for a self-reference (it would send retrieval off
 *  searching for a name the user never typed). */
function withTargetType(query: string, intent: IntentResult): IntentResult {
  const targetType = resolveTargetType(query, intent.searchParams, intent.targetType);
  if (targetType !== "SELF") return { ...intent, targetType };
  const { personRef: _dropped, ...rest } = intent.searchParams;
  return { ...intent, searchParams: rest, targetType };
}
