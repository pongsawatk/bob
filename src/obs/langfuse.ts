import { env } from "../env.js";
import { Langfuse } from "langfuse";

export interface LFSpan {
  end: (output: unknown) => void;
}

export interface LFTrace {
  span: (name: string) => LFSpan;
  update: (opts: { output: string; metadata?: Record<string, unknown> }) => void;
}

const noopSpan: LFSpan = { end: () => {} };
const noopTrace: LFTrace = { span: () => noopSpan, update: () => {} };

// One client per warm instance. We deliberately do NOT set flushAt:1 / auto-flush:
// on serverless that would fire background (un-awaited) flushes which get killed
// when the lambda freezes after responding → traces lost. Instead events stay
// queued (~5 per request, below the default flushAt) and are sent in a single
// awaited flushObs() before the handler returns.
const _lf: Langfuse | null =
  env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
    ? new Langfuse({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_HOST,
      })
    : null;

console.log(`[langfuse] ${_lf ? `enabled (${env.LANGFUSE_HOST})` : "disabled — keys missing"}`);

export function startTrace(traceId: string, userId: string, input?: string): LFTrace {
  if (!_lf) return noopTrace;

  const t = _lf.trace({ id: traceId, name: "bob-chat", userId, input });
  return {
    span: (name) => {
      const s = t.span({ name });
      return { end: (output) => s.end({ output }) };
    },
    update: (opts) => {
      t.update(opts);
    },
  };
}

/** Attach a score to an existing trace by id (e.g. 👍/👎 feedback). */
export async function scoreTrace(traceId: string, name: string, value: number): Promise<void> {
  if (!_lf) return;
  _lf.score({ traceId, name, value, dataType: "NUMERIC" });
  await flushObs();
}

/** Send all queued events. Must be awaited before a serverless handler returns. */
export async function flushObs(): Promise<void> {
  if (!_lf) return;
  try {
    await _lf.flushAsync();
  } catch (err) {
    console.error("[langfuse] flush failed:", err);
  }
}
