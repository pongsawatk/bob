import type { LFTrace } from '../obs/langfuse.js';
import { withBudget, BudgetExceededError } from '../http/budget.js';
/** A timed-out send may already have reached Teams. Never resend automatically. */
export class DeliveryError extends Error {
  constructor(public status: 'failed' | 'unknown', options?: ErrorOptions) {
    super(`Reply delivery ${status}`, options); this.name = 'DeliveryError';
  }
}
export async function deliverAnswer(trace: LFTrace, send: () => Promise<unknown>, timeoutMs = 6000): Promise<boolean> {
  const span = trace.span('delivery');
  const start = Date.now();
  try {
    const result = await withBudget(timeoutMs, send);
    span.end({ deliveryStatus: result === false ? 'cancelled' : 'sent', latencyMs: Date.now() - start });
    return result !== false;
  } catch (cause) {
    const status = cause instanceof BudgetExceededError ? 'unknown' : 'failed';
    span.end({ deliveryStatus: status, latencyMs: Date.now() - start });
    throw new DeliveryError(status, { cause });
  }
}
