// fetch() with a per-attempt timeout and budget-aware retries.
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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRetryableStatus = (s: number) => s === 429 || s >= 500;

export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const { retries = 2, timeoutMs = 30_000, backoffMs = 400 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (isRetryableStatus(res.status) && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt + Math.random() * 200);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Timeout/abort: too expensive to retry within the function budget.
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (attempt < retries) {
        await sleep(backoffMs * 2 ** attempt + Math.random() * 200);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
