# WP-12 — /insight Job, Auth & Delivery (plan)

Decision owner: Jor (2026-07-11). Gate: **G1** — spikes #1/#2/#4 resolved; **#3 Teams delivery still pending** (gates the *deliver* stage only). Prompt creation + secrets + `api/teams.ts` wiring need approval (§7.4/§7.6).

## Decision: Option B — QStash durable queue, staged + resumable
Rationale (from spike #2): every Vercel invocation is capped at **≈58s** regardless of `waitUntil`; the 30d window + Langfuse rate limit (§1) + unmeasured LLM latency make a single-invocation job unsafe. So the job is split into **resumable stages**, each with an internal **40–45s deadline**, that checkpoint to Redis and enqueue a continuation. `waitUntil` is NOT the primary runner (only best-effort side work that can't fail the report). QStash does NOT extend any single invocation — never enqueue one worker to "do everything to the end."

### Flow (one code path for 7d and 30d)
```
/insight [7d|14d|30d]
  → authorize (tenant + AAD group via checkMemberGroups; email allowlist = temp fallback)
  → newJob(): jobId + idempotencyKey (requestedBy|window|BangkokDay)  [dedupe /insight spam]
  → JobStore.create (NX on idempotencyKey; return existing job if same-day dup)
  → status: queued → enqueue QStash {jobId, stage:"fetch"} → ACK jobId to user (≤3s)

Worker: stage "fetch"      (resumable)
  → fetch traces page-by-page (limit=100, 429 backoff)
  → normalize + redact each page → append to Redis stateRef (TTL)
  → nextFetchStep(cursor, page, deadline): continue | yield(→enqueue same stage) | advance
  → when all pages done → status: running, stage: aggregate → enqueue {jobId,"aggregate"}

Worker: stage "aggregate"  → aggregate() over stored turns → completeness gate → stage: analyze
Worker: stage "analyze"    → buildAnalysisInput(aggregate + redacted samples) → LLM → validateAnalysis
                             → retry (bounded) → fallback null (numbers-only) → store reportRef → stage: deliver
Worker: stage "deliver"    → summary card → secure link/file (IF spike #3 passes) → chunked fallback
                             → status: completed

/insight-status <jobId>    → READ-ONLY (never resumes work)
```

### Hard requirements (user-specified, non-negotiable)
- **QStash signature verified on every worker request** (`@upstash/qstash` Receiver).
- **Idempotency**: job-level (idempotencyKey) + worker-level (`claimStage(jobId, stage:cursor)`), because the queue is **at-least-once**. Delivery must tolerate duplicates.
- **No PII / raw traces in the queue payload** — only `{jobId, stage}`. Normalized+**redacted** state lives in Redis with TTL.
- **Bounded retries** + explicit `failed` / `partial` statuses.
- Worker internal deadline **40–45s** (leave margin for checkpoint + continuation enqueue), not ~58s.

## Invariants preserved
Pipeline `precache→router→domainBot` untouched. `/insight` added beside `/refresh`,`/clear` in `teams.ts` (extend, not rewrite). Redaction (WP-11) is the only path trace text takes before the LLM. All numbers from code (WP-10), never the model.

## Build order (each a small, tested, reviewable slice)
1. **[this slice] `src/analytics/job.ts`** — vendor-agnostic spine: job model, `Deadline` budget guard, idempotency keys, `nextFetchStep` resume decision, `JobStore` interface + `InMemoryJobStore`. Pure/unit-tested. **No Redis/QStash/prod.**
2. `src/analytics/analyze.ts` — `buildAnalysisInput` (PII-safe LLM payload) + `analyzeWithRetry(llmCall injected)` → validate/retry/fallback. Unit-tested with a fake llmCall.
3. Redis `JobStore` impl (thin, `getRedis`) + QStash client wrapper (enqueue + `Receiver.verify`) — needs `@upstash/qstash` dep + `QSTASH_TOKEN`/keys (**secrets → Jor**).
4. Worker endpoints `api/insight/worker.ts` (+ signature verify) and command handling in `teams.ts` (auth + ACK). **Touches prod → approval.**
5. Analysis prompt in Langfuse (label `production`). **Shared infra → approval.**
6. Deliver stage — depends on **spike #3** outcome.

## Stop conditions for this WP (do not cross without approval)
Adding `@upstash/qstash` + `QSTASH_*` secrets; wiring `/insight` into the live `api/teams.ts`; deploying worker routes; creating the Langfuse prompt; AAD group id config; any real enqueue/LLM-billed run.

## Tests-first (slice 1)
`test/job.test.ts`: idempotency key stability/uniqueness + Bangkok day bucket; `Deadline.shouldYield` boundaries; `nextFetchStep` continue/yield/advance; `InMemoryJobStore` create-dedupe/update/claimStage.
