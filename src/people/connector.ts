// People Connector — Wave-1 orchestrator. Chains the pieces built in WP-20→22:
//   extractIntent (LLM) → evaluatePolicy → retrieve → compose (LLM + post-check)
// over the live For-All directory. Tag intents (owner/expert/idea) have no data
// until G0, so they land on a "coming soon" reply. Dependencies are injected so
// this is unit-testable with mock LLMs + a fixture directory; defaultPeopleDeps()
// wires the real OpenRouter + directory for the admin-shadow /people command.

import { callLLM } from "../llm/openrouter.js";
import type { LFGeneration } from "../obs/langfuse.js";
import { env } from "../env.js";
import { getActiveDirectory, getDirectoryMeta, getDirectoryNames } from "./directory.js";
import { extractIntent, INTENT_SYSTEM_PROMPT, type LlmCall } from "./intent/extract.js";
import { evaluatePolicy } from "./policy/gate.js";
import { retrieve, tagMapFromDirectory, type TagMap } from "./retrieval/search.js";
import { employmentPolicyFromEnv, filterServable, type EmploymentPolicy } from "./policy/employment.js";
import { compose, templateFallback } from "./responder/compose.js";
import { createAuditLog, type AuditLog } from "./audit/log.js";
import { type PolicyOutcome, type SubIntent, type TargetType } from "./pcTypes.js";
import { resolveRequester, type IdentityStatus, type RequesterIdentity } from "./identity.js";
import type { Profile } from "./directory.js";
import type { ProfileMap } from "./profileStore.js";

export const RESPONDER_SYSTEM_PROMPT = `คุณคือ BOB ผู้ช่วยของ Builk One Group ตอบคำถามเรื่อง "ใครคือใคร / อยู่ทีมไหน / หัวหน้าคือใคร" จากทะเบียนพนักงาน
ตอบสั้น เป็นมิตร ภาษาไทย ลงท้าย "ครับ"
กติกาเด็ดขาด: ใช้เฉพาะข้อมูลใน FACTS ที่ส่งมาให้เท่านั้น ห้ามเพิ่มชื่อบุคคล อีเมล ตำแหน่ง ทีม หรือคุณสมบัติใด ๆ ที่ไม่มีใน FACTS เด็ดขาด
ถ้า FACTS ว่างให้บอกว่ายังไม่พบ`;

const MSG = {
  refuse: "ขอโทษครับ คำถามนี้ผมช่วยไม่ได้ — ผมไม่ให้ข้อมูลส่วนตัว การจัดอันดับบุคคล หรือรายชื่อทั้งบริษัทครับ 🙏",
  clarify: "ช่วยระบุให้ชัดขึ้นอีกนิดได้ไหมครับ เช่น ชื่อคน ชื่อทีม หรือหัวหน้าที่ต้องการทราบ 🙏",
  // Appended when results are inferred from Org/Sub Org rather than an approved tag.
  confirmHr:
    "\n\nℹ️ อันนี้ผมแนะนำจากข้อมูลทีม/ตำแหน่งในทะเบียนนะครับ อาจไม่แม่นทั้งหมด รบกวนยืนยันกับ HR อีกทีเพื่อความชัวร์ 🙏",
  // Identity failures — each says what went wrong, so the user isn't told their
  // question found nothing when the truth is BOB couldn't tell who was asking.
  identityNotFound:
    "ขอโทษครับ ผมยังจับคู่บัญชีของคุณกับทะเบียนพนักงานไม่ได้ เลยยังตอบคำถามเกี่ยวกับตัวคุณเองไม่ได้ 🙏 รบกวนสอบถาม HR เพื่อยืนยันอีเมลในทะเบียนได้เลยครับ",
  identityAmbiguous:
    "ขอโทษครับ ผมพบข้อมูลในทะเบียนที่ใช้อีเมลของคุณซ้ำกันมากกว่า 1 รายการ เลยยังไม่กล้าตอบเพราะอาจสลับคนได้ 🙏 รบกวนแจ้ง HR ให้ตรวจสอบทะเบียนอีกทีนะครับ",
  profileInactive:
    "ขอโทษครับ สถานะพนักงานของบัญชีนี้ในทะเบียนยังไม่พร้อมให้ผมตอบข้อมูลส่วนตัวครับ 🙏 รบกวนสอบถาม HR โดยตรงนะครับ",
  noSupervisor:
    "ผมดูในทะเบียนแล้วไม่พบชื่อหัวหน้าที่ระบุไว้ครับ 🙏 อาจเป็นเพราะยังไม่ได้กรอกไว้ หรือคุณอยู่ระดับบนสุดของสายงาน — รบกวนยืนยันกับ HR อีกทีนะครับ",
};

export interface PeopleDeps {
  intentLlm: LlmCall;
  responderLlm: LlmCall;
  getDirectory: () => Promise<ProfileMap>;
  getKnownNames: () => Promise<string[]>;
  /** self-resolution kill-switch (WP-01). false → self questions behave as before
   *  (no identity binding) while every other People answer keeps working. */
  selfEnabled?: boolean;
  /** published-snapshot freshness for the answer footer (WP-10.1). Omitted/failing →
   *  no footer, never a guessed date. */
  getMeta?: () => Promise<{ sourceUpdatedAt?: string; lastSyncedAt?: string } | null>;
  /** approved tags override; when omitted, derived from the directory's ownership
   *  column (empty until HR fills it → tag intents stay "coming soon"). */
  tags?: TagMap;
  /** employment-status gate; empty/omitted → serve everyone (inert). */
  employmentPolicy?: EmploymentPolicy;
  audit?: AuditLog;
  now?: Date;
}

/** Who is asking, and what was said just before. Typed and explicit — never read off
 *  global/request metadata, so one conversation's context cannot reach another's. */
export interface PeopleContext {
  requester?: RequesterIdentity;
  /** recent turns of THIS conversation, for follow-ups ("เอาเฉพาะ tester"). Passed by
   *  the caller that owns the conversation scope; the connector holds no state. */
  history?: { role: "user" | "assistant"; content: string }[];
}

/**
 * "ข้อมูลทะเบียน ณ <date>" footer (WP-10.1). The sheet is edited on HR's schedule, so a
 * new joiner can legitimately be missing and a leaver can linger — saying when the
 * snapshot is from lets the reader judge that instead of trusting a stale roster.
 * No stamp → no footer. Never a guessed date.
 */
async function freshnessNote(deps: PeopleDeps): Promise<string> {
  if (!deps.getMeta) return "";
  try {
    const meta = await deps.getMeta();
    const iso = meta?.sourceUpdatedAt ?? meta?.lastSyncedAt;
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const shown = d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" });
    return `\n\n_ข้อมูลทะเบียน ณ ${shown}_`;
  } catch {
    return "";
  }
}

/** Why a turn produced no answer. `usedFallback` alone could not distinguish "the
 *  model couldn't parse the question" from "the person genuinely isn't in the
 *  registry" from "we couldn't tell who was asking" — so every no-result looked the
 *  same in a trace and none of them were actionable (WP-07). */
export type PeopleErrorStage =
  | "INTENT_FALLBACK"
  | "IDENTITY"
  | "POLICY_REFUSE"
  | "POLICY_CLARIFY"
  | "NO_RESULT"
  | "NEEDS_CLARIFICATION"
  | "NO_SUPERVISOR"
  | "RESPONDER_VALIDATION_FAILED";

export interface PeopleResult {
  text: string;
  outcome: PolicyOutcome;
  subIntent: SubIntent;
  resultCount: number;
  /** kept for backward compatibility with existing traces/dashboards; prefer the
   *  stage-specific flags below, which say WHICH stage degraded. */
  usedFallback: boolean;
  /** the extractor exhausted both attempts and returned the confidence-0 fallback. */
  intentFallback?: boolean;
  /** retrieval found nothing for a well-formed query. */
  retrievalFallback?: boolean;
  /** the responder's output was discarded (validation failed / empty / errored) and a
   *  deterministic template was shipped instead. */
  responderFallback?: boolean;
  /** why this turn ended where it did — every answerless turn has exactly one. */
  errorStage?: PeopleErrorStage;
  /** per-stage latency, so a slow turn points at a stage instead of a total. */
  stages?: { identityMs?: number; intentMs?: number; retrievalMs?: number; responderMs?: number };
  /** how identity binding went, for self questions only (WP-01/WP-07). Absent when
   *  the question wasn't about the asker or self-resolution is disabled. */
  identityOutcome?: IdentityStatus;
  /** pseudonymous requester id for telemetry — never the email. */
  identityKey?: string;
  targetType?: TargetType;
}

export async function handlePeopleQuery(
  query: string,
  deps: PeopleDeps,
  ctx: PeopleContext = {},
): Promise<PeopleResult> {
  const now = deps.now ?? new Date();
  const selfEnabled = deps.selfEnabled !== false;
  const stages: NonNullable<PeopleResult["stages"]> = {};

  const tIntent = Date.now();
  // History is what turns "เอาเฉพาะ tester" from an unanswerable fragment into
  // team=DX AND role=tester. The extractor always accepted one; nothing ever passed it.
  const intent = await extractIntent(query, deps.intentLlm, { history: ctx.history });
  stages.intentMs = Date.now() - tIntent;

  const decision = evaluatePolicy({ queryText: query, intentResult: intent });
  const isSelf = selfEnabled && intent.targetType === "SELF";

  let identityOutcome: IdentityStatus | undefined;
  let identityKeyOut: string | undefined;

  const finish = (
    text: string,
    resultCount = 0,
    usedFallback = false,
    extra: { errorStage?: PeopleErrorStage; responderFallback?: boolean; retrievalFallback?: boolean } = {},
  ): PeopleResult => {
    deps.audit?.record({
      subIntent: intent.subIntent,
      policyOutcome: decision.outcome,
      resultCount,
      timestamp: now.getTime(),
    });
    return {
      text,
      outcome: decision.outcome,
      subIntent: intent.subIntent,
      resultCount,
      usedFallback,
      stages,
      ...(intent.extractionFallback ? { intentFallback: true } : {}),
      ...(extra.retrievalFallback ? { retrievalFallback: true } : {}),
      ...(extra.responderFallback ? { responderFallback: true } : {}),
      ...(extra.errorStage ? { errorStage: extra.errorStage } : {}),
      ...(identityOutcome ? { identityOutcome } : {}),
      ...(identityKeyOut ? { identityKey: identityKeyOut } : {}),
      ...(intent.targetType ? { targetType: intent.targetType } : {}),
    };
  };

  if (decision.outcome === "REFUSE") return finish(MSG.refuse, 0, false, { errorStage: "POLICY_REFUSE" });
  if (decision.outcome === "CLARIFY" || decision.outcome === "UNABLE_TO_DETERMINE") {
    // An unparseable question and a genuinely vague one both land here but are
    // different problems: one is a model/prompt failure, the other is the user.
    return finish(MSG.clarify, 0, true, {
      errorStage: intent.extractionFallback ? "INTENT_FALLBACK" : "POLICY_CLARIFY",
    });
  }

  // ALLOW — run retrieval over the live directory, minus anyone the employment
  // gate excludes (inert until HR fills the status column + configures it).
  const all = await deps.getDirectory();
  const directory = filterServable(all, deps.employmentPolicy ?? {});

  // Bind the asker before retrieval when the question is about them. Each failure is
  // its own answer: telling someone "ไม่พบ" when we simply couldn't identify them is
  // the misleading behavior this WP exists to remove.
  let requester: Profile | undefined;
  if (isSelf) {
    const tId = Date.now();
    const res = resolveRequester({ servable: directory, all, identity: ctx.requester ?? {} });
    stages.identityMs = Date.now() - tId;
    identityOutcome = res.status;
    if (res.status === "SELF_RESOLVED") {
      requester = res.profile;
      identityKeyOut = res.key;
    } else {
      const msg =
        res.status === "IDENTITY_AMBIGUOUS"
          ? MSG.identityAmbiguous
          : res.status === "PROFILE_INACTIVE"
            ? MSG.profileInactive
            : MSG.identityNotFound;
      return finish(msg, 0, true, { errorStage: "IDENTITY" });
    }
  }

  const tags = deps.tags ?? tagMapFromDirectory(directory);
  const tRetrieval = Date.now();
  const response = retrieve({ intent: isSelf ? intent : { ...intent, targetType: undefined }, directory, tags, now, requester });
  stages.retrievalMs = Date.now() - tRetrieval;

  if (response.noSupervisor) return finish(MSG.noSupervisor, 0, true, { errorStage: "NO_SUPERVISOR" });

  // The team term maps to more than one real team in the registry → ask which one.
  // Guessing here is how a confident wrong roster gets shipped (WP-05).
  if (response.needsClarification && response.clarifyOptions?.length) {
    const opts = response.clarifyOptions.map((o) => `• ${o}`).join("\n");
    return finish(`ตอนนี้ในทะเบียนมีมากกว่า 1 ทีมที่ตรงกับที่ถามครับ หมายถึงทีมไหนดีครับ 🙏\n${opts}`, 0, true, {
      errorStage: "NEEDS_CLARIFICATION",
    });
  }

  // A count question is answered from `totalMatches` with no rows and no LLM call,
  // so an empty `results` here is a real answer rather than a miss.
  if (response.totalMatches === 0) {
    return finish(templateFallback([]), 0, true, { errorStage: "NO_RESULT", retrievalFallback: true });
  }

  const knownNames = await deps.getKnownNames();
  const tResponder = Date.now();
  const composed = await compose({
    results: response.results,
    query,
    llm: deps.responderLlm,
    knownNames,
    totalMatches: response.totalMatches,
    shownCount: response.shownCount,
    truncated: response.truncated,
    countOnly: response.countOnly,
    filtersApplied: response.filtersApplied,
  });
  stages.responderMs = Date.now() - tResponder;

  // Inferred (Org/Sub Org guess) → append the "confirm with HR" note.
  const base = response.inferred ? composed.text + MSG.confirmHr : composed.text;
  const text = base + (await freshnessNote(deps));
  return finish(text, response.totalMatches, composed.usedFallback, {
    responderFallback: composed.usedFallback,
    // A discarded responder output is an answer we still shipped, but it's the signal
    // that the model is fighting the retrieval result — worth seeing in a trace.
    ...(composed.usedFallback && composed.reason && composed.reason !== "deterministic_count"
      ? { errorStage: "RESPONDER_VALIDATION_FAILED" as const }
      : {}),
  });
}

// ── Real wiring for the /people command ───────────────────────────────────

/** Audit accumulates in-memory per warm instance (resets on cold start) — fine
 *  for a low-volume admin shadow; a durable sink can come at pilot. */
const sharedAudit = createAuditLog();

/** Records one LLM call as a Langfuse generation. Injected so the connector stays
 *  unit-testable and so obs wiring lives at the call site (WP-07). */
export type GenRecorder = (gen: LFGeneration) => void;

/**
 * @param recordGeneration when supplied, the intent + responder calls are logged as
 * child generations. Without this, PEOPLE turns carried no generation at all, so
 * their tokens and cost were invisible to `/insight` — PEOPLE looked nearly free
 * while being the only category running two uninstrumented LLM calls.
 */
export function defaultPeopleDeps(recordGeneration?: GenRecorder): PeopleDeps {
  /** Wrap a callLLM invocation so its usage/cost/latency reach the trace. */
  const instrumented = (name: string, model: string, maxTokens: number, temperature: number, systemPrompt: string): LlmCall =>
    async (user) => {
      const r = await callLLM({
        model,
        systemPrompt,
        messages: [{ role: "user", content: user }],
        maxTokens,
        temperature,
      });
      recordGeneration?.({
        name,
        model,
        version: "inline", // migrates to a Langfuse prompt version with Prompt B/C
        input: user,
        output: r.text,
        latencyMs: r.latencyMs,
        usage: {
          input: r.usage.inputTokens,
          output: r.usage.outputTokens,
          total: r.usage.inputTokens + r.usage.outputTokens,
          totalCost: r.costUsd,
        },
      });
      return r.text;
    };

  const intentLlm = instrumented("people:intent", env.MODEL_ROUTER, 200, 0, INTENT_SYSTEM_PROMPT);
  // good Thai composing; only reached for answers that actually need phrasing —
  // counts and rosters are templated (WP-03).
  const responderLlm = instrumented("people:responder", env.MODEL_HR, 400, 0.3, RESPONDER_SYSTEM_PROMPT);

  return {
    intentLlm,
    responderLlm,
    getDirectory: getActiveDirectory,
    getKnownNames: getDirectoryNames,
    // tags omitted → derived from the directory ownership column each request.
    employmentPolicy: employmentPolicyFromEnv(env),
    selfEnabled: env.PEOPLE_SELF_ENABLED !== "0",
    getMeta: getDirectoryMeta,
    audit: sharedAudit,
  };
}
