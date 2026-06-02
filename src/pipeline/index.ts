import crypto from "node:crypto";
import { checkPrecache } from "./precache.js";
import { routeMessage, type Category } from "./router.js";
import { callDomainBot } from "./domainBot.js";
import { startTrace, flushObs } from "../obs/langfuse.js";
import type { LLMMessage } from "../llm/openrouter.js";

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

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { message, userId, userName = "คุณ", department = "", channel = "teams", sessionId, history = [] } = input;
  const traceId = crypto.randomUUID();
  const t0 = Date.now();

  const trace = startTrace({ traceId, userId, sessionId, input: message });
  const baseMeta = { channel, department, userName };

  // ── Tier 0: Pre-cache ──────────────────────────────────────────
  const precacheSpan = trace.span("precache");
  const precacheHit = checkPrecache(message);
  precacheSpan.end({ hit: !!precacheHit, category: precacheHit?.category });

  if (precacheHit) {
    trace.update({
      output: precacheHit.answer,
      metadata: { ...baseMeta, category: precacheHit.category, fromCache: true },
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
  const routed = await routeMessage(message, history);
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

  // ── Tier 2-4: Domain Bot ───────────────────────────────────────
  const botResult = await callDomainBot(routed.category, message, userName, department, history);
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
    metadata: { cacheReadTokens: botResult.usage.cacheReadTokens },
  });

  trace.update({
    output: botResult.text,
    metadata: {
      ...baseMeta,
      category: routed.category,
      confidence: routed.confidence,
      latencyMs: Date.now() - t0,
      inputTokens: botResult.usage.inputTokens,
      outputTokens: botResult.usage.outputTokens,
      cacheReadTokens: botResult.usage.cacheReadTokens,
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
