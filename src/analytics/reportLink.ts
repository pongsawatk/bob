// WP-12 slice 6 — signed, expiring link to a stored report. The deliver stage sends
// a summary card with an Action.OpenUrl to this link (spike #3: file upload needs an
// invoke handler; the link path is proven). Token = HMAC(jobId) so the URL isn't
// guessable; the report's 24h Redis TTL makes the link naturally expire.

import crypto from "node:crypto";
import { env } from "../env.js";

const secret = () => env.CRON_SECRET || "insight-dev-secret";

export const reportRedisKey = (jobId: string) => `bob:insight:job:${jobId}:state:report`;

export function signReportToken(jobId: string): string {
  return crypto.createHmac("sha256", secret()).update(jobId).digest("hex").slice(0, 32);
}

export function verifyReportToken(jobId: string, token: string): boolean {
  if (!jobId || !token) return false;
  const expected = signReportToken(jobId);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/** Public URL of the report, derived from INSIGHT_WORKER_URL. null if not configured. */
export function reportUrl(jobId: string): string | null {
  const base = env.INSIGHT_WORKER_URL;
  if (!base) return null;
  const endpoint = base.replace(/\/api\/insight\/worker\/?$/, "/api/insight/report");
  return `${endpoint}?jobId=${encodeURIComponent(jobId)}&token=${signReportToken(jobId)}`;
}
