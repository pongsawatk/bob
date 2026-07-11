// WP-12 slice 4 (DRAFT) — /insight command: parse, authorize, create job, enqueue, ACK.
// Wired into teams.ts behind INSIGHT_ENABLED (default off). parseInsightCommand is pure
// and unit-tested; the rest is thin glue over the job store + queue.

import { env } from "../env.js";
import { graphToken } from "../people/directory.js";
import { fetchRetry } from "../http/fetchRetry.js";
import { newJob, type WindowDays } from "../analytics/job.js";
import { RedisJobStore } from "../analytics/jobStoreRedis.js";
import { enqueueStage } from "../analytics/queue.js";

export type InsightCommand =
  | { kind: "report"; days: WindowDays }
  | { kind: "status"; jobId: string }
  | { kind: "usage"; message: string };

const USAGE_REPORT = "ใช้: `/insight [7d|14d|30d]` (ค่าเริ่มต้น 7d)";
const USAGE_STATUS = "ใช้: `/insight-status <jobId>`";

/**
 * Parse an /insight command per the Metric Contract §2.2 rules: trim ends, split on
 * 1+ whitespace, case-insensitive command + arg, `/insight` alone → 7d, accept only
 * 7d|14d|30d (else usage; never guess/adjust). Returns null if it isn't our command.
 */
export function parseInsightCommand(raw: string): InsightCommand | null {
  const text = raw.trim();
  // /insight-status is more specific — check it before /insight (\b matches the hyphen).
  if (/^\/insight-status\b/i.test(text)) {
    const parts = text.split(/\s+/);
    if (parts.length !== 2 || !parts[1]) return { kind: "usage", message: USAGE_STATUS };
    return { kind: "status", jobId: parts[1] };
  }
  if (!/^\/insight\b/i.test(text)) return null;

  const parts = text.split(/\s+/);
  if (parts.length > 2) return { kind: "usage", message: USAGE_REPORT }; // extra tokens → usage
  const arg = parts[1];
  if (arg === undefined) return { kind: "report", days: 7 }; // bare /insight → default
  switch (arg.toLowerCase()) {
    case "7d": return { kind: "report", days: 7 };
    case "14d": return { kind: "report", days: 14 };
    case "30d": return { kind: "report", days: 30 };
    default: return { kind: "usage", message: USAGE_REPORT };
  }
}

// ── Authorization ──────────────────────────────────────────────────────

function adminEmails(): string[] {
  return env.KB_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** True if this user may run /insight. Primary gate = AAD group membership (spike #4
 *  confirmed the bot app can read it); email allowlist is the documented temp fallback. */
export async function isInsightAdmin(aadObjectId: string, email: string): Promise<boolean> {
  if (env.INSIGHT_ADMIN_GROUP_ID) {
    try {
      const token = await graphToken();
      // checkMemberGroups is the cheap "is X in these groups?" call (one round-trip).
      const res = await fetchRetry(
        `https://graph.microsoft.com/v1.0/users/${aadObjectId}/checkMemberGroups`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ groupIds: [env.INSIGHT_ADMIN_GROUP_ID] }),
        },
        { retries: 1, timeoutMs: 10_000 }
      );
      if (res.ok) {
        const j = (await res.json()) as { value?: string[] };
        return (j.value ?? []).includes(env.INSIGHT_ADMIN_GROUP_ID);
      }
      // Fall through to email fallback on Graph error rather than hard-denying.
    } catch (err) {
      console.error("isInsightAdmin: group check failed, falling back to email:", err);
    }
  }
  return !!email && adminEmails().includes(email.toLowerCase());
}

// ── Command handling (returns reply text; teams.ts sends it) ────────────

export interface InsightCaller {
  aadObjectId: string;
  email: string;
}

/** Authorize, create (or dedupe) the job, enqueue the first stage, return the ACK. */
export async function handleInsightCommand(cmd: InsightCommand, caller: InsightCaller): Promise<string> {
  if (cmd.kind === "usage") return cmd.message;

  if (!(await isInsightAdmin(caller.aadObjectId, caller.email))) {
    return "ขออภัยครับ คำสั่ง /insight ใช้ได้เฉพาะผู้ดูแลที่ได้รับสิทธิ์เท่านั้นครับ";
  }

  const store = new RedisJobStore();

  if (cmd.kind === "status") {
    const job = await store.get(cmd.jobId);
    if (!job) return `ไม่พบงาน \`${cmd.jobId}\` ครับ (อาจหมดอายุแล้ว)`;
    const line = job.error ? `\nสาเหตุ: ${job.error}` : "";
    return `สถานะงาน \`${job.jobId}\`: **${job.status}** (stage: ${job.stage})${line}`;
  }

  // report
  const job = newJob({ requestedBy: caller.aadObjectId, windowDays: cmd.days });
  const { created, existing } = await store.create(job);
  if (!created && existing) {
    return `มีรายงาน ${cmd.days}d ของวันนี้อยู่แล้วครับ — เช็คสถานะ: \`/insight-status ${existing.jobId}\``;
  }
  await store.update(job.jobId, { status: "queued" });
  await enqueueStage({ jobId: job.jobId, stage: "fetch" });
  return `รับคำสั่งแล้วครับ ⏳ กำลังสร้างรายงาน ${cmd.days}d\nเช็คสถานะได้ที่: \`/insight-status ${job.jobId}\``;
}
