import { checkPrecache } from "./precache.js";
import { routeMessage, type Category } from "./router.js";
import { callDomainBot } from "./domainBot.js";
import { runWithTrace, type LFTrace } from "../obs/langfuse.js";
import type { LLMMessage } from "../llm/openrouter.js";
import { handlePeopleQuery, defaultPeopleDeps } from "../people/connector.js";
import type { RequesterIdentity } from "../people/identity.js";
import { peopleEnabled } from "../channels/people.js";
import { decideRoute } from './routePolicy.js';
import { SYSTEM_POLICY_VERSION } from '../prompts/systemPolicy.js';
import { domainOutcome, peopleOutcome } from './outcome.js';
import { withBudget, BudgetExceededError, requestBudget } from '../http/budget.js';
import { deliverAnswer } from './delivery.js';

export type { LLMMessage };

export interface PipelineInput {
  message: string;
  userId: string;
  userName?: string;
  department?: string;
  channel?: string;
  /** Conversation id — used as the Langfuse session id to group turns. */
  sessionId?: string;
  history?: LLMMessage[];
  /**
   * Rendered profile block of the ASKER only (see people/directory.ts) —
   * injected as an uncached system block. Never contains other employees.
   */
  profileBlock?: string;
  /**
   * Verified identity of the ASKER (WP-01). Typed and passed explicitly rather than
   * inferred from `userId`, which collapses to an AAD id when getMember fails and so
   * cannot be told apart from a real email. People Connector binds self-reference
   * questions ("หัวหน้าฉันคือใคร") on this.
   */
  requester?: RequesterIdentity;
  /** Absolute deadline shared with Teams preparation; default 45s from entry. */
  deadlineMs?: number;
}

export interface PipelineOutput {
  errorStage?: 'TIMEOUT' | 'PIPELINE';
  traceId: string;
  category: Category;
  answer: string;
  latencyMs: number;
  fromCache: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
}

// Flips to true after this warm instance serves its first request. The first
// request after a cold boot pays one-time costs (empty prompt/KB caches, first
// Redis/Langfuse round-trips), so tagging coldStart lets us separate cold from
// warm latency when profiling the pipeline overhead.
let instanceWarmed = false;

export async function runPipeline(input: PipelineInput, deliver?: (output: PipelineOutput) => Promise<unknown>): Promise<PipelineOutput> {
  const { message, userId, channel = "teams", sessionId } = input;
  return runWithTrace({ userId, sessionId, channel, input: message }, async (trace) => {
    const output = await runBoundedPipeline(input, trace);
    if (deliver) await deliverAnswer(trace, () => deliver(output));
    return output;
  });
}

export async function runBoundedPipeline(input: PipelineInput, trace: LFTrace, deps = { route: routeMessage, domain: callDomainBot }): Promise<PipelineOutput> {
  const start = Date.now();
  let active = true;
  const pending = new Set<ReturnType<LFTrace['span']>>();
  const guarded: LFTrace = {
    traceId: trace.traceId,
    update: o => { if (active) trace.update(o); },
    generation: g => { if (active) trace.generation(g); },
    span: name => {
      const s = active ? trace.span(name) : undefined;
      if (s) pending.add(s);
      return { end: o => { if (active && s) { s.end(o); pending.delete(s); } } };
    },
  };
  try {
    return await withBudget((input.deadlineMs ?? start + 45_000) - start, () => runPipelineTraced(input, guarded, deps));
  } catch (err) {
    const errorStage = err instanceof BudgetExceededError || (err instanceof Error && err.name === 'AbortError') ? 'TIMEOUT' : 'PIPELINE';
    const answer = errorStage === 'TIMEOUT' ? 'ขออภัยครับ ระบบใช้เวลาตอบนานเกินไป กรุณาลองใหม่อีกครั้งครับ' : 'ขออภัยครับ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งครับ';
    trace.update({ output: answer, metadata: { channel: input.channel ?? 'teams', category: 'GENERAL', answerStatus: 'failed', outcomeSource: 'deterministic', errorStage, latencyMs: Date.now() - start, systemPolicyVersion: SYSTEM_POLICY_VERSION }, tags: [input.channel ?? 'teams', 'failed'] });
    console.error(`[pipeline] ${errorStage}`);
    return { traceId: trace.traceId, category: 'GENERAL', answer, errorStage, latencyMs: Date.now() - start, fromCache: false, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
  } finally {
    active = false;
    for (const span of pending) span.end({ status: 'cancelled_or_failed' });
  }
}

export async function runPipelineTraced(input: PipelineInput, trace: LFTrace, deps = { route: routeMessage, domain: callDomainBot }): Promise<PipelineOutput> {
  const { message, userId, userName = "คุณ", department = "", channel = "teams", sessionId, history = [], profileBlock, requester } = input;
  const traceId = trace.traceId;
  const t0 = Date.now();
  const coldStart = !instanceWarmed;
  instanceWarmed = true;

  const baseMeta = { channel, department, userName, systemPolicyVersion: SYSTEM_POLICY_VERSION };

  // ── Tier 0: Pre-cache ──────────────────────────────────────────
  const precacheSpan = trace.span("precache");
  const precacheHit = checkPrecache(message);
  precacheSpan.end({ hit: !!precacheHit, category: precacheHit?.category });

  if (precacheHit) {
    trace.update({
      output: precacheHit.answer,
      metadata: { ...baseMeta, category: precacheHit.category, fromCache: true, coldStart, latencyMs: Math.max(1, Date.now() - t0), answerStatus: 'answered' },
      tags: [channel, precacheHit.category, "precache"],
    });
    return {
      traceId,
      category: precacheHit.category,
      answer: precacheHit.answer,
      latencyMs: Date.now() - t0,
      fromCache: true,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  // ── Tier 1: Router ─────────────────────────────────────────────
  const routeSpan = trace.span("route");
  const tRoute = Date.now();
  const routed = await deps.route(message, history);
  requestBudget()?.signal.throwIfAborted();
  const routeMs = Date.now() - tRoute;
  routeSpan.end({ category: routed.category, promptMs: routed.promptMs, llmMs: routed.latencyMs });
  trace.generation({
    name: "router",
    model: routed.model,
    version: routed.promptVersion,
    input: message,
    output: routed.rawJson,
    latencyMs: routed.latencyMs,
    usage: {
      input: routed.usage.inputTokens,
      output: routed.usage.outputTokens,
      total: routed.usage.inputTokens + routed.usage.outputTokens,
      totalCost: routed.costUsd,
    },
    metadata: { confidence: routed.confidence },
  });

  const decision = decideRoute(routed, message, history);
  Object.assign(baseMeta, { originalCategory: routed.category, routeReason: decision.reason });
  routed.category = decision.category;
  if (decision.clarification) {
    const latencyMs = Math.max(1, Date.now() - t0);
    trace.update({ output: decision.clarification, metadata: { ...baseMeta, category: routed.category, latencyMs, answerStatus: 'clarification', outcomeSource: 'deterministic' }, tags: [channel, routed.category, 'clarification'] });
    return { traceId, category: routed.category, answer: decision.clarification, latencyMs, fromCache: false, usage: { inputTokens: routed.usage.inputTokens, outputTokens: routed.usage.outputTokens, cacheReadTokens: 0 } };
  }

  // ── People Connector ───────────────────────────────────────────
  // Person/team/reporting lookups over the For-All directory. Enabled for
  // everyone behind PEOPLE_ENABLED (kill-switch). Separate handler — the domain
  // bots keep their "refuse info about others" rule as defense-in-depth, so a
  // cross-person question misrouted to HR/GENERAL still never leaks.
  if (peopleEnabled() && routed.category === "PEOPLE") {
    const peopleSpan = trace.span("people");
    const tPeople = Date.now();
    // Log the intent + responder calls as child generations, so PEOPLE turns carry
    // their real token/cost figures. Without this they reported none at all, which
    // made the only two-LLM-call category look like the cheapest one.
    const res = await handlePeopleQuery(message, defaultPeopleDeps((g) => trace.generation(g)), {
      requester,
      // Scoped to this conversation by the caller — the connector keeps no state, so
      // one conversation's context cannot reach another's.
      history: history.slice(-4).map((m) => ({ role: m.role, content: m.content })),
    });
    peopleSpan.end({
      subIntent: res.subIntent,
      outcome: res.outcome,
      resultCount: res.resultCount,
      targetType: res.targetType,
      identityOutcome: res.identityOutcome,
      errorStage: res.errorStage,
    });
    trace.update({
      output: res.text,
      metadata: {
        ...baseMeta,
        category: "PEOPLE",
        ...peopleOutcome(res),
        subIntent: res.subIntent,
        policyOutcome: res.outcome,
        resultCount: res.resultCount,
        usedFallback: res.usedFallback,
        // Stage-specific degradation (WP-07): `usedFallback` alone couldn't say WHICH
        // stage gave up, so every no-result looked identical and none were actionable.
        intentFallback: res.intentFallback,
        retrievalFallback: res.retrievalFallback,
        responderFallback: res.responderFallback,
        errorStage: res.errorStage,
        // Self-reference telemetry (WP-01): pseudonymous key only, never the email.
        targetType: res.targetType,
        identityOutcome: res.identityOutcome,
        identityKey: res.identityKey,
        latencyMs: Date.now() - t0,
        coldStart,
        timings: { peopleMs: Date.now() - tPeople, ...res.stages },
      },
      tags: [channel, "PEOPLE", "llm"],
    });
    return {
      traceId,
      category: "PEOPLE",
      answer: res.text,
      latencyMs: Date.now() - t0,
      fromCache: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }

  // ── Tier 2-4: Domain Bot ───────────────────────────────────────
  const domainSpan = trace.span("domain");
  const tDomain = Date.now();
  const botResult = await deps.domain(routed.category, message, userName, department, history, profileBlock);
  requestBudget()?.signal.throwIfAborted();
  const domainMs = Date.now() - tDomain;
  domainSpan.end({
    category: routed.category,
    promptMs: botResult.promptMs,
    kbMs: botResult.kbMs,
    llmMs: botResult.latencyMs,
  });
  if (botResult.model) trace.generation({
    name: `domain:${routed.category}`,
    model: botResult.model,
    version: botResult.promptVersion,
    input: message,
    output: botResult.text,
    latencyMs: botResult.latencyMs,
    usage: {
      input: botResult.usage.inputTokens,
      output: botResult.usage.outputTokens,
      total: botResult.usage.inputTokens + botResult.usage.outputTokens,
      totalCost: botResult.costUsd,
    },
    metadata: { cacheReadTokens: botResult.usage.cacheReadTokens, kbSelect: botResult.kbSelect, systemPolicyVersion: SYSTEM_POLICY_VERSION },
  });

  const totalMs = Date.now() - t0;
  // Latency breakdown for overhead profiling. "overhead" = time NOT spent in the
  // two LLM calls (router + domain fetch) = prompt fetch + KB assembly + glue.
  const overheadMs = totalMs - routed.latencyMs - botResult.latencyMs;
  const timings = {
    coldStart,
    totalMs,
    overheadMs,
    routeMs,
    domainMs,
    routerPromptMs: routed.promptMs,
    routerLlmMs: routed.latencyMs,
    domainPromptMs: botResult.promptMs,
    domainKbMs: botResult.kbMs,
    domainLlmMs: botResult.latencyMs,
  };

  trace.update({
    output: botResult.text,
    metadata: {
      ...baseMeta,
      category: routed.category,
      confidence: routed.confidence,
      ...domainOutcome(botResult.text, routed.category),
      ...(botResult.evidenceGap ? { answerStatus: 'partial', outcomeSource: 'deterministic', evidenceGap: botResult.evidenceGap, reviewRequired: true } : {}),
      eligibilityGuarded: botResult.eligibilityGuarded ?? false,
      itCollectionId: botResult.itCollectionId,
      citationGuarded: botResult.citationGuarded,
      // Flag only — never the profile content (keeps PII out of Langfuse).
      hasProfile: !!profileBlock,
      latencyMs: totalMs,
      inputTokens: botResult.usage.inputTokens,
      outputTokens: botResult.usage.outputTokens,
      cacheReadTokens: botResult.usage.cacheReadTokens,
      kbSelect: botResult.kbSelect && {
        mode: botResult.kbSelect.mode,
        docs: `${botResult.kbSelect.selected}/${botResult.kbSelect.total}`,
        chars: botResult.kbSelect.chars,
        fullChars: botResult.kbSelect.fullChars,
        sources: botResult.kbSelect.sources,
        contextUsed: botResult.kbSelect.contextUsed,
      },
      timings,
    },
    tags: [channel, routed.category, "llm"],
  });

  return {
    traceId,
    category: routed.category,
    answer: botResult.text,
    latencyMs: Date.now() - t0,
    fromCache: false,
    usage: {
      inputTokens: botResult.usage.inputTokens,
      outputTokens: botResult.usage.outputTokens,
      cacheReadTokens: botResult.usage.cacheReadTokens,
    },
  };
}
