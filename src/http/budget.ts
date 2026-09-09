import { AsyncLocalStorage } from 'node:async_hooks';
export class BudgetExceededError extends Error {
  constructor() { super('Request time budget exceeded'); this.name = 'BudgetExceededError'; }
}
const scope = new AsyncLocalStorage<{ deadline: number; signal: AbortSignal }>();
export const requestBudget = () => scope.getStore();

/** Bounds the caller and propagates cancellation to HTTP work in this request only. */
export async function withBudget<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const parent = scope.getStore();
  const duration = Math.max(0, Math.min(ms, parent ? parent.deadline - Date.now() : ms));
  const signal = parent ? AbortSignal.any([ctrl.signal, parent.signal]) : ctrl.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => reject(new BudgetExceededError());
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => ctrl.abort(), duration);
      if (signal.aborted || duration <= 0) ctrl.abort();
      if (signal.aborted) onAbort();
    });
    return await scope.run({ deadline: Date.now() + duration, signal }, () =>
      Promise.race([expired, Promise.resolve().then(() => {
        if (signal.aborted) throw new BudgetExceededError();
        return fn();
      })]));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
