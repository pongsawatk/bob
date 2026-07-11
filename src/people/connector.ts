// People Connector — Wave-1 orchestrator. Chains the pieces built in WP-20→22:
//   extractIntent (LLM) → evaluatePolicy → retrieve → compose (LLM + post-check)
// over the live For-All directory. Tag intents (owner/expert/idea) have no data
// until G0, so they land on a "coming soon" reply. Dependencies are injected so
// this is unit-testable with mock LLMs + a fixture directory; defaultPeopleDeps()
// wires the real OpenRouter + directory for the admin-shadow /people command.

import { callLLM } from "../llm/openrouter.js";
import { env } from "../env.js";
import { getActiveDirectory, getDirectoryNames } from "./directory.js";
import { extractIntent, INTENT_SYSTEM_PROMPT, type LlmCall } from "./intent/extract.js";
import { evaluatePolicy } from "./policy/gate.js";
import { retrieve, tagMapFromDirectory, type TagMap } from "./retrieval/search.js";
import { compose, templateFallback } from "./responder/compose.js";
import { createAuditLog, type AuditLog } from "./audit/log.js";
import { DIRECTORY_INTENTS, type PolicyOutcome, type SubIntent } from "./pcTypes.js";
import type { ProfileMap } from "./profileStore.js";

export const RESPONDER_SYSTEM_PROMPT = `คุณคือ BOB ผู้ช่วยของ Builk One Group ตอบคำถามเรื่อง "ใครคือใคร / อยู่ทีมไหน / หัวหน้าคือใคร" จากทะเบียนพนักงาน
ตอบสั้น เป็นมิตร ภาษาไทย ลงท้าย "ครับ"
กติกาเด็ดขาด: ใช้เฉพาะข้อมูลใน FACTS ที่ส่งมาให้เท่านั้น ห้ามเพิ่มชื่อบุคคล อีเมล ตำแหน่ง ทีม หรือคุณสมบัติใด ๆ ที่ไม่มีใน FACTS เด็ดขาด
ถ้า FACTS ว่างให้บอกว่ายังไม่พบ`;

const MSG = {
  refuse: "ขอโทษครับ คำถามนี้ผมช่วยไม่ได้ — ผมไม่ให้ข้อมูลส่วนตัว การจัดอันดับบุคคล หรือรายชื่อทั้งบริษัทครับ 🙏",
  clarify: "ช่วยระบุให้ชัดขึ้นอีกนิดได้ไหมครับ เช่น ชื่อคน ชื่อทีม หรือหัวหน้าที่ต้องการทราบ 🙏",
  comingSoon:
    "ตอนนี้ผมยังตอบเรื่อง “ใครดูแล/เชี่ยวชาญเรื่องนี้” ไม่ได้ครับ (กำลังจะเปิดเร็ว ๆ นี้) — แต่ถามหา “คน / ทีม / หัวหน้า” ได้เลยนะครับ 😊",
};

export interface PeopleDeps {
  intentLlm: LlmCall;
  responderLlm: LlmCall;
  getDirectory: () => Promise<ProfileMap>;
  getKnownNames: () => Promise<string[]>;
  /** approved tags override; when omitted, derived from the directory's ownership
   *  column (empty until HR fills it → tag intents stay "coming soon"). */
  tags?: TagMap;
  audit?: AuditLog;
  now?: Date;
}

export interface PeopleResult {
  text: string;
  outcome: PolicyOutcome;
  subIntent: SubIntent;
  resultCount: number;
  usedFallback: boolean;
}

export async function handlePeopleQuery(query: string, deps: PeopleDeps): Promise<PeopleResult> {
  const now = deps.now ?? new Date();
  const intent = await extractIntent(query, deps.intentLlm);
  const decision = evaluatePolicy({ queryText: query, intentResult: intent });

  const finish = (text: string, resultCount = 0, usedFallback = false): PeopleResult => {
    deps.audit?.record({
      subIntent: intent.subIntent,
      policyOutcome: decision.outcome,
      resultCount,
      timestamp: now.getTime(),
    });
    return { text, outcome: decision.outcome, subIntent: intent.subIntent, resultCount, usedFallback };
  };

  if (decision.outcome === "REFUSE") return finish(MSG.refuse);
  if (decision.outcome === "CLARIFY" || decision.outcome === "UNABLE_TO_DETERMINE") return finish(MSG.clarify, 0, true);

  // ALLOW — run retrieval over the live directory. Tags come from an explicit
  // override or are derived from the directory's ownership column (empty → dark).
  const directory = await deps.getDirectory();
  const tags = deps.tags ?? tagMapFromDirectory(directory);
  const response = retrieve({ intent, directory, tags, now });

  if (response.results.length === 0) {
    // Tag intents have no data yet → signal it's coming; directory intents just
    // didn't match → the safe not-found template.
    const msg = DIRECTORY_INTENTS.has(intent.subIntent) ? templateFallback([]) : MSG.comingSoon;
    return finish(msg, 0, true);
  }

  const knownNames = await deps.getKnownNames();
  const composed = await compose({ results: response.results, query, llm: deps.responderLlm, knownNames });
  return finish(composed.text, response.results.length, composed.usedFallback);
}

// ── Real wiring for the /people command ───────────────────────────────────

/** Audit accumulates in-memory per warm instance (resets on cold start) — fine
 *  for a low-volume admin shadow; a durable sink can come at pilot. */
const sharedAudit = createAuditLog();

export function defaultPeopleDeps(): PeopleDeps {
  const intentLlm: LlmCall = async (user) =>
    (
      await callLLM({
        model: env.MODEL_ROUTER,
        systemPrompt: INTENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        maxTokens: 200,
        temperature: 0,
      })
    ).text;

  const responderLlm: LlmCall = async (user) =>
    (
      await callLLM({
        model: env.MODEL_HR, // good Thai composing; shadow volume is tiny
        systemPrompt: RESPONDER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        maxTokens: 400,
        temperature: 0.3,
      })
    ).text;

  return {
    intentLlm,
    responderLlm,
    getDirectory: getActiveDirectory,
    getKnownNames: getDirectoryNames,
    // tags omitted → derived from the directory ownership column each request.
    audit: sharedAudit,
  };
}
