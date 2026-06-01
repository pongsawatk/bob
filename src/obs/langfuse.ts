import { env } from "../env.js";

export interface LFSpan {
  end: (output: unknown) => void;
}

export interface LFTrace {
  span: (name: string) => LFSpan;
  score: (name: string, value: number) => void;
}

const noopSpan: LFSpan = { end: () => {} };
const noopTrace: LFTrace = { span: () => noopSpan, score: () => {} };

// Lazy Langfuse client (sync init using require — avoids top-level await)
let _ready = false;
let _lf: {
  trace: (opts: { id: string; name: string; userId: string }) => {
    span: (opts: { name: string }) => { end: (opts: { output: unknown }) => void };
    score: (opts: { name: string; value: number }) => void;
  };
  flushAsync: () => Promise<void>;
} | null = null;

function initLF() {
  if (_ready) return;
  _ready = true;
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Langfuse } = require("langfuse") as typeof import("langfuse");
    _lf = new Langfuse({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_HOST,
      flushAt: 1,
      flushInterval: 0,
    }) as typeof _lf;
  } catch {
    _lf = null;
  }
}

export function startTrace(traceId: string, userId: string): LFTrace {
  initLF();
  if (!_lf) return noopTrace;

  const t = _lf.trace({ id: traceId, name: "bob-chat", userId });
  return {
    span: (name: string) => {
      const s = t.span({ name });
      return { end: (output: unknown) => s.end({ output }) };
    },
    score: (name: string, value: number) => t.score({ name, value }),
  };
}

export async function flushObs(): Promise<void> {
  if (_lf) await _lf.flushAsync();
}
