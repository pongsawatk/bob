// WP-12 slice 3 (DRAFT) — QStash queue wrapper. Inert until the QSTASH_* envs are set.
// Enqueues tiny PII-free stage messages and verifies inbound worker requests really
// came from QStash. Clients are created lazily so importing this never throws.

import { Client, Receiver } from "@upstash/qstash";
import { env } from "../env.js";
import type { QueueMessage } from "./job.js";

/** Master arming switch — the whole /insight feature no-ops unless this is "1". */
export function insightEnabled(): boolean {
  return env.INSIGHT_ENABLED === "1";
}

let _client: Client | null = null;
function client(): Client {
  if (!env.QSTASH_TOKEN) throw new Error("QSTASH_TOKEN not configured");
  return (_client ??= new Client({ token: env.QSTASH_TOKEN }));
}

let _receiver: Receiver | null = null;
function receiver(): Receiver {
  if (!env.QSTASH_CURRENT_SIGNING_KEY || !env.QSTASH_NEXT_SIGNING_KEY) {
    throw new Error("QSTASH signing keys not configured");
  }
  return (_receiver ??= new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
  }));
}

/** Enqueue a stage continuation. Body is the whole payload — {jobId, stage} only,
 *  PII-free by type. QStash retries + at-least-once delivery are why workers dedupe. */
export async function enqueueStage(msg: QueueMessage): Promise<void> {
  if (!env.INSIGHT_WORKER_URL) throw new Error("INSIGHT_WORKER_URL not configured");
  await client().publishJSON({ url: env.INSIGHT_WORKER_URL, body: msg, retries: 3 });
}

/** Verify a worker request came from QStash (upstash-signature header). Never throws;
 *  returns false on missing/invalid signature or misconfiguration → caller sends 401. */
export async function verifyQStash(signature: string | undefined, body: string, url?: string): Promise<boolean> {
  if (!signature) return false;
  try {
    return await receiver().verify({ signature, body, ...(url ? { url } : {}) });
  } catch {
    return false;
  }
}
