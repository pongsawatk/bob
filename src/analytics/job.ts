// WP-12 — /insight job state machine (vendor-agnostic, pure spine).
// No Redis, no QStash, no env: this is the testable core the queue workers build on.
// See docs/implementation/WP-12-plan.md. Queue is at-least-once → everything here is
// idempotent + resumable; every stage runs under a ~40-45s budget (Vercel caps at ~58s,
// confirmed by G1 spike #2), checkpoints, then enqueues a continuation.

import crypto from "node:crypto";

export type JobStage = "fetch" | "aggregate" | "analyze" | "deliver" | "done";
export type JobStatus =
  | "queued"
  | "running"
  | "needs-continuation"
  | "completed"
  | "partial"
  | "failed";

export const STAGE_ORDER: JobStage[] = ["fetch", "aggregate", "analyze", "deliver", "done"];
export type WindowDays = 7 | 14 | 30;

/** Spike #2: invocations die at ~58s. Yield with margin to checkpoint + re-enqueue. */
export const DEFAULT_WORKER_BUDGET_MS = 45_000;

export interface FetchCursor {
  page: number; // next page to fetch (1-based)
  totalPages: number | null;
  fetched: number; // raw traces fetched so far
}

export interface JobRecord {
  jobId: string;
  idempotencyKey: string;
  /** aadObjectId — PII-minimized (not email). */
  requestedBy: string;
  windowDays: WindowDays;
  stage: JobStage;
  status: JobStatus;
  cursor: FetchCursor | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Redis key holding normalized+redacted turns (never inlined into the queue). */
  stateRef: string;
  /** Redis key holding the rendered report. */
  reportRef?: string;
}

/** The ENTIRE queue payload — tiny + PII-free (hard requirement). */
export interface QueueMessage {
  jobId: string;
  stage: JobStage;
}

// ── Idempotency ────────────────────────────────────────────────────────

const BKK_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function bangkokDay(nowMs: number = Date.now()): string {
  return BKK_DAY.format(new Date(nowMs));
}

/** Same admin + same window + same Bangkok day = the same job (dedupe /insight spam). */
export function jobIdempotencyKey(requestedBy: string, windowDays: WindowDays, nowMs: number = Date.now()): string {
  const raw = `${requestedBy.toLowerCase()}|${windowDays}|${bangkokDay(nowMs)}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** At-least-once dedup tag for a worker doing (stage[, cursor page]). */
export function stageClaimTag(stage: JobStage, cursorPage?: number): string {
  return cursorPage != null ? `${stage}:${cursorPage}` : stage;
}

export function newJob(params: { requestedBy: string; windowDays: WindowDays; nowMs?: number }): JobRecord {
  const now = params.nowMs ?? Date.now();
  const jobId = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  return {
    jobId,
    idempotencyKey: jobIdempotencyKey(params.requestedBy, params.windowDays, now),
    requestedBy: params.requestedBy,
    windowDays: params.windowDays,
    stage: "fetch",
    status: "queued",
    cursor: null,
    attempts: 0,
    maxAttempts: 5,
    createdAt: iso,
    updatedAt: iso,
    stateRef: `bob:insight:job:${jobId}:state`,
  };
}

// ── Budget guard ───────────────────────────────────────────────────────

/** Wall-clock deadline for one worker invocation. `now` is injectable for tests. */
export class Deadline {
  private readonly startedAt: number;
  constructor(private readonly budgetMs: number = DEFAULT_WORKER_BUDGET_MS, startedAt?: number) {
    this.startedAt = startedAt ?? Date.now();
  }
  elapsedMs(now: number = Date.now()): number {
    return now - this.startedAt;
  }
  remainingMs(now: number = Date.now()): number {
    return this.budgetMs - this.elapsedMs(now);
  }
  /** True when too little time remains to safely do more work + checkpoint. */
  shouldYield(marginMs = 5000, now: number = Date.now()): boolean {
    return this.remainingMs(now) <= marginMs;
  }
}

// ── Resumable fetch decision (pure) ────────────────────────────────────

export interface PageResult {
  page: number; // page just fetched (1-based)
  totalPages: number;
  count: number; // rows returned for this page
}

export type FetchDecision =
  | { action: "continue"; cursor: FetchCursor } // more pages + budget left → keep going now
  | { action: "yield"; cursor: FetchCursor } // more pages, no budget → enqueue continuation
  | { action: "advance"; cursor: FetchCursor }; // all pages fetched → move to aggregate

/** Given the page we just fetched + remaining budget, decide the next fetch action. */
export function nextFetchStep(
  prev: FetchCursor | null,
  page: PageResult,
  deadline: Deadline,
  now: number = Date.now()
): FetchDecision {
  const fetched = (prev?.fetched ?? 0) + page.count;
  const done = page.page >= page.totalPages || page.count === 0;
  if (done) {
    return { action: "advance", cursor: { page: page.page, totalPages: page.totalPages, fetched } };
  }
  const cursor: FetchCursor = { page: page.page + 1, totalPages: page.totalPages, fetched };
  return deadline.shouldYield(5000, now) ? { action: "yield", cursor } : { action: "continue", cursor };
}

// ── Job store (interface + in-memory impl; Redis impl is a separate thin slice) ──

export interface JobStore {
  /** Create unless an unexpired job with the same idempotencyKey exists. */
  create(job: JobRecord): Promise<{ created: boolean; existing?: JobRecord }>;
  get(jobId: string): Promise<JobRecord | null>;
  getByIdempotency(key: string): Promise<JobRecord | null>;
  update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord>;
  /** At-least-once dedup: true the FIRST time (jobId, tag) is claimed, false after. */
  claimStage(jobId: string, tag: string): Promise<boolean>;
}

export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>();
  private byIdem = new Map<string, string>();
  private claims = new Set<string>();

  async create(job: JobRecord): Promise<{ created: boolean; existing?: JobRecord }> {
    const existingId = this.byIdem.get(job.idempotencyKey);
    if (existingId) return { created: false, existing: this.jobs.get(existingId)! };
    this.jobs.set(job.jobId, job);
    this.byIdem.set(job.idempotencyKey, job.jobId);
    return { created: true };
  }
  async get(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }
  async getByIdempotency(key: string): Promise<JobRecord | null> {
    const id = this.byIdem.get(key);
    return id ? this.jobs.get(id)! : null;
  }
  async update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`job ${jobId} not found`);
    const next = { ...j, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(jobId, next);
    return next;
  }
  async claimStage(jobId: string, tag: string): Promise<boolean> {
    const k = `${jobId}:${tag}`;
    if (this.claims.has(k)) return false;
    this.claims.add(k);
    return true;
  }
}
