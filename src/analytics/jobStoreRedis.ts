// WP-12 slice 3 (DRAFT) — Redis-backed JobStore (Upstash). Mirrors InMemoryJobStore
// semantics: idempotent create (NX on idempotencyKey), read-modify-write update, and
// at-least-once claimStage dedup. Records carry a 24h TTL. Integration-tested later;
// the pure logic is already covered by InMemoryJobStore tests.

import { getRedis } from "../store/redis.js";
import type { JobRecord, JobStore } from "./job.js";

const jobKey = (id: string) => `bob:insight:job:${id}`;
const idemKey = (k: string) => `bob:insight:idem:${k}`;
const claimKey = (id: string, tag: string) => `bob:insight:claim:${id}:${tag}`;
const TTL = 60 * 60 * 24; // 24h

export class RedisJobStore implements JobStore {
  private r = getRedis();

  async create(job: JobRecord): Promise<{ created: boolean; existing?: JobRecord }> {
    if (!this.r) throw new Error("Redis not configured");
    // Claim the idempotencyKey → jobId mapping atomically (NX). If it already exists,
    // this is a same-day duplicate request → return the original job instead.
    const claimed = await this.r.set(idemKey(job.idempotencyKey), job.jobId, { nx: true, ex: TTL });
    if (claimed === null) {
      const existing = await this.getByIdempotency(job.idempotencyKey);
      return { created: false, existing: existing ?? undefined };
    }
    await this.r.set(jobKey(job.jobId), job, { ex: TTL });
    return { created: true };
  }

  async get(jobId: string): Promise<JobRecord | null> {
    if (!this.r) return null;
    return (await this.r.get<JobRecord>(jobKey(jobId))) ?? null;
  }

  async getByIdempotency(key: string): Promise<JobRecord | null> {
    if (!this.r) return null;
    const id = await this.r.get<string>(idemKey(key));
    return id ? this.get(id) : null;
  }

  async update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    if (!this.r) throw new Error("Redis not configured");
    // Read-modify-write. Safe here because the queue serializes stages per job and
    // claimStage() dedupes duplicate deliveries, so concurrent writers don't overlap.
    const cur = await this.get(jobId);
    if (!cur) throw new Error(`job ${jobId} not found`);
    const next: JobRecord = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await this.r.set(jobKey(jobId), next, { ex: TTL });
    return next;
  }

  async claimStage(jobId: string, tag: string): Promise<boolean> {
    if (!this.r) return true; // no Redis → don't block (best-effort, dev only)
    const set = await this.r.set(claimKey(jobId, tag), 1, { nx: true, ex: TTL });
    return set !== null;
  }

  /** Drop the idempotency mapping so the same request can be retried (e.g. after an
   *  enqueue failure). Does not delete the job record itself. */
  async releaseIdempotency(idempotencyKey: string): Promise<void> {
    if (this.r) await this.r.del(idemKey(idempotencyKey));
  }

  /** Release a stage claim so a failed attempt can be retried by QStash. */
  async releaseClaim(jobId: string, tag: string): Promise<void> {
    if (this.r) await this.r.del(claimKey(jobId, tag));
  }
}
