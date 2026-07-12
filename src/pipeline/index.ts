import crypto from "node:crypto";
import { checkPrecache } from "./precache.js";
import { routeMessage, type Category } from "./router.js";
import { callDomainBot } from "./domainBot.js";
import { startTrace, flushObs } from "../obs/langfuse.js";
import type { LLMMessage } from "../llm/openrouter.js";
import { handlePeopleQuery, defaultPeopleDeps } from "../people/connector.js";
import { peopleEnabled } from "../channels/people.js";

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
}

export interface PipelineOutput {
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

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { message, userId, userName = "คุณ", department = "", channel = "teams", sessionId, history = [], profileBlock } = input;
  const traceId = crypto.randomUUID();
  const t0 = Date.now();
  const coldStart = !instanceWarmed;
  instanceWarmed = true;

  const trace = startTrace({ traceId, userId, sessionId, input: message });
  const baseMeta = { channel, department, userName };

  // ── Tier 0: Pre-cache ──────────────────────────────────────────
  const precacheSpan = trace.span("precache");
  const precacheHit = checkPrecache(message);
  precacheSpan.end({ hit: !!precacheHit, category: precacheHit?.category });

  if (precacheHit) {
    trace.update({
      output: precacheHit.answer,
      metadata: { ...baseMeta, category: precacheHit.category, fromCache: true, coldStart },
      tags: [channel, precacheHit.category, "precache"],
    });
    await flushObs();
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
  const routed = await routeMessage(message, history);
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

  // ── People Connector ───────────────────────────────────────────
  // Person/team/reporting lookups over the For-All directory. Enabled for
  // everyone behind PEOPLE_ENABLED (kill-switch). Separate handler — the domain
  // bots keep their "refuse info about others" rule as defense-in-depth, so a
  // cross-person question misrouted to HR/GENERAL still never leaks.
  if (peopleEnabled() && routed.category === "PEOPLE") {
    const peopleSpan = trace.span("people");
    const tPeople = Date.now();
    const res = await handlePeopleQuery(message, defaultPeopleDeps());
    peopleSpan.end({ subIntent: res.subIntent, outcome: res.outcome, resultCount: res.resultCount });
    trace.update({
      output: res.text,
      metadata: {
        ...baseMeta,
        category: "PEOPLE",
        subIntent: res.subIntent,
        policyOutcome: res.outcome,
        resultCount: res.resultCount,
        usedFallback: res.usedFallback,
        latencyMs: Date.now() - t0,
        coldStart,
        timings: { peopleMs: Date.now() - tPeople },
      },
      tags: [channel, "PEOPLE", "llm"],
    });
    await flushObs();
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
  const botResult = await callDomainBot(routed.category, message, userName, department, history, profileBlock);
  const domainMs = Date.now() - tDomain;
  domainSpan.end({
    category: routed.category,
    promptMs: botResult.promptMs,
    kbMs: botResult.kbMs,
    llmMs: botResult.latencyMs,
  });
  trace.generation({
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
    metadata: { cacheReadTokens: botResult.usage.cacheReadTokens, kbSelect: botResult.kbSelect },
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
      },
      timings,
    },
    tags: [channel, routed.category, "llm"],
  });

  await flushObs();

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
