import { requestBudget, BudgetExceededError } from './budget.js';
// Buffered fetch: timeout includes body download. Not for streaming consumers.
//
// Retry policy (tuned for Vercel's 60s function budget):
//  - Retryable HTTP status (429 / 5xx) → retry: these come back fast, so a
//    couple of quick retries are cheap and rescue transient provider hiccups.
//  - Network error (no response) → retry.
//  - Timeout (AbortError) → do NOT retry: a second long attempt would risk
//    blowing the function budget. Fail fast so the caller can fall back.

export interface FetchRetryOptions {
  /** Max retries after the first attempt (default 2). */
  retries?: number;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Base backoff in ms; grows exponentially with jitter (default 400). */
  backoffMs?: number;
  budgetMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});
const isRetryableStatus = (s: number) => s === 429 || s >= 500;

export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const { retries = 2, timeoutMs = 30_000, backoffMs = 400, budgetMs = 45_000 } = opts;
  const context = requestBudget();
  const deadline = Math.min(Date.now() + budgetMs, context?.deadline ?? Infinity);
  const parentSignal = AbortSignal.any([context?.signal, init.signal].filter((s): s is AbortSignal => !!s));

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || context?.signal.aborted) throw new BudgetExceededError();
    const ctrl = new AbortController();
    const signal = AbortSignal.any([ctrl.signal, parentSignal]);
    const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, remaining));
    try {
      signal.throwIfAborted();
      const res = await fetch(url, { ...init, signal });
      if (isRetryableStatus(res.status) && attempt < retries) {
        await res.body?.cancel();
      } else {
        const bytes = await res.arrayBuffer();
        signal.throwIfAborted();
        return new Response([204, 205, 304].includes(res.status) ? null : bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    } catch (err) {
      // Timeout/abort: too expensive to retry within the function budget.
      if (signal.aborted || attempt >= retries) throw err;
    } finally {
      clearTimeout(timer);
    }
    const delay = backoffMs * 2 ** attempt + (backoffMs ? Math.random() * 200 : 0);
    if (Date.now() + delay >= deadline) throw new BudgetExceededError();
    await sleep(delay, parentSignal);
  }
}
