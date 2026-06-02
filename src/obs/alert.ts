// Fire-and-forget error alerts to a Teams Incoming Webhook (ALERT_WEBHOOK_URL).
// No-op when the webhook isn't configured. Never throws — alerting must not
// break the request that triggered it.

import { env } from "../env.js";
import { fetchRetry } from "../http/fetchRetry.js";

export async function alertError(context: string, err: unknown): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    await fetchRetry(
      env.ALERT_WEBHOOK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Teams Incoming Webhook accepts a simple { text } payload.
        body: JSON.stringify({ text: `🚨 **BOB error** — ${context}\n\n${detail}` }),
      },
      { retries: 0, timeoutMs: 3000 }
    );
  } catch (e) {
    console.error("alertError: webhook post failed:", e);
  }
}
