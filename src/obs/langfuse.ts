import crypto from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  startActiveObservation,
  startObservation,
  type LangfuseSpan,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { env } from "../env.js";

export interface LFSpan {
  end: (output: unknown) => void;
}

export interface LFGeneration {
  name: string;
  model: string;
  /** Prompt version — shows in Langfuse's Version column. */
  version: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  /** Token counts + actual cost (USD) — drives Langfuse's Model/Cost columns. */
  usage: { input: number; output: number; total: number; totalCost: number };
  /** Extra context (e.g. cacheReadTokens for prompt-cache ROI). */
  metadata?: Record<string, unknown>;
}

export interface LFTraceStart {
  userId: string;
  /** Groups all turns of one conversation in Langfuse's Sessions view. */
  sessionId?: string;
  channel?: string;
  input?: string;
}

export interface LFTrace {
  /** The real OpenTelemetry/Langfuse trace id returned to feedback scoring. */
  traceId: string;
  span: (name: string) => LFSpan;
  generation: (gen: LFGeneration) => void;
  update: (opts: { output: string; metadata?: Record<string, unknown>; tags?: string[] }) => void;
}

const configured = Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);

// Langfuse v5 is OpenTelemetry-based. Serverless functions use immediate export,
// then forceFlush() after the root observation has ended so no span is left behind
// when Vercel freezes the instance.
const spanProcessor = configured
  ? new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_HOST,
      exportMode: "immediate",
    })
  : null;

const otelSdk = spanProcessor ? new NodeSDK({ spanProcessors: [spanProcessor] }) : null;
otelSdk?.start();

const client = configured
  ? new LangfuseClient({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_HOST,
    })
  : null;

console.log(`[langfuse] ${configured ? `enabled v5 (${env.LANGFUSE_HOST})` : "disabled — keys missing"}`);

function noOpTrace(): LFTrace {
  return {
    traceId: crypto.randomUUID(),
    span: () => ({ end: () => {} }),
    generation: () => {},
    update: () => {},
  };
}

/** Adapter kept exported so hierarchy/attribute behavior can be verified in-memory. */
export function createTraceAdapter(root: LangfuseSpan): LFTrace {
  return {
    traceId: root.traceId,
    span: (name) => {
      const span = root.startObservation(name);
      return {
        end: (output) => {
          span.update({ output });
          span.end();
        },
      };
    },
    generation: ({ name, model, version, input, output, latencyMs, usage, metadata }) => {
      const generation = startObservation(
        name,
        {
          model,
          version,
          input,
          metadata,
          usageDetails: {
            input: usage.input,
            output: usage.output,
            total: usage.total,
          },
          costDetails: { total: usage.totalCost },
        },
        {
          asType: "generation",
          startTime: new Date(Date.now() - latencyMs),
          parentSpanContext: root.otelSpan.spanContext(),
        },
      );
      generation.update({ output });
      generation.end();
    },
    update: ({ output, metadata, tags }) => {
      // Root observation I/O replaces deprecated trace-level I/O. The stable
      // channel tag is propagated before child creation; late-bound category/type
      // tags are also stamped on the root's trace attributes to retain UI filters.
      if (tags) {
        root.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, JSON.stringify(tags));
      }
      root.update({ output, metadata: tags ? { ...metadata, tags } : metadata });
    },
  };
}

/**
 * Run one complete BOB turn inside a root observation. Correlating attributes are
 * established before any child is created, and the root is ended before flushing.
 */
export async function runWithTrace<T>(start: LFTraceStart, fn: (trace: LFTrace) => Promise<T>): Promise<T> {
  if (!spanProcessor) return fn(noOpTrace());

  try {
    return await propagateAttributes(
      {
        traceName: "bob-chat",
        userId: start.userId,
        sessionId: start.sessionId,
        tags: start.channel ? [start.channel] : undefined,
        metadata: start.channel ? { channel: start.channel } : undefined,
      },
      () =>
        startActiveObservation("bob-chat", async (root) => {
          root.update({ input: start.input });
          return fn(createTraceAdapter(root));
        }),
    );
  } finally {
    await flushObs();
  }
}

/** Attach a score to an existing trace by id (e.g. 👍/👎 feedback). */
export async function scoreTrace(traceId: string, name: string, value: number): Promise<void> {
  if (!client) return;
  client.score.create({ traceId, name, value });
  await client.score.flush();
}

/** Send every ended observation before a serverless handler returns. */
export async function flushObs(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch (err) {
    console.error("[langfuse] flush failed:", err);
  }
}
