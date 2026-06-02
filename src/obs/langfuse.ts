import { env } from "../env.js";
import { Langfuse } from "langfuse";

export interface LFSpan {
  end: (output: unknown) => void;
}

export interface LFTrace {
  span: (name: string) => LFSpan;
  score: (name: string, value: number) => void;
  update: (opts: { output: string; metadata?: Record<string, unknown> }) => void;
}

const noopSpan: LFSpan = { end: () => {} };
const noopTrace: LFTrace = { span: () => noopSpan, score: () => {}, update: () => {} };

const _lf: Langfuse | null =
  env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
    ? new Langfuse({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_HOST,
        flushAt: 1,
        flushInterval: 0,
      })
    : null;

export function startTrace(traceId: string, userId: string, input?: string): LFTrace {
  if (!_lf) return noopTrace;

  const t = _lf.trace({ id: traceId, name: "bob-chat", userId, input });
  return {
    span: (name: string) => {
      const s = t.span({ name });
      return { end: (output: unknown) => s.end({ output }) };
    },
    score: (name: string, value: number) => t.score({ name, value }),
    update: (opts) => t.update(opts),
  };
}

export async function scoreTrace(traceId: string, name: string, value: number): Promise<void> {
  if (!_lf) return;
  _lf.score({ traceId, name, value, dataType: "NUMERIC" });
  await _lf.flushAsync();
}

export async function flushObs(): Promise<void> {
  if (_lf) await _lf.flushAsync();
}
