# WP-00 — Repository Discovery

Reference: Notion "BOB Implementation Reference — People Connector + Continuous Improvement Analytics" (§4.3).
Scope of this WP: **map the real system, change no feature code.** Session-entry contract (§7.6): current WP = `WP-00`, gates G0/G1 Pending → discovery + baseline only.

Date: 2026-07-11 · Branch `main` @ `ab65c7c` · Node ≥20, ESM, TypeScript, deployed on Vercel.

---

## Architecture map (verified, with paths/symbols)

**Request path (Teams):** `api/teams.ts` → `src/channels/teams.ts#handleTeamsRequest` → `src/pipeline/index.ts#runPipeline` → `precache → router → domainBot` → Adaptive Card reply.

- **Pipeline** `src/pipeline/index.ts#runPipeline`: order is `checkPrecache` → `routeMessage` → `callDomainBot`, then `trace.update`. **No discrete "normalize" step** (spec wording); output is finalized inline. Prompt-cache + per-turn Langfuse trace with spans (`precache`,`route`,`domain`) and 2 generations (`router`, `domain:<cat>`).
- **Router** `src/pipeline/router.ts`: `type Category = "HR"|"PRODUCT"|"GENERAL"|"UNKNOWN"`. Parses JSON from `MODEL_ROUTER` (`google/gemini-3.1-flash-lite`). JSON reminder is inlined in the user message (matches memory `feedback-router-gemini`). **No `PEOPLE` intent.**
- **Domain bots** `src/pipeline/domainBot.ts#callDomainBot`: switch on category (HR/PRODUCT/GENERAL/UNKNOWN). Each fetches a Langfuse prompt (`getPrompt`), assembles KB, calls `callLLM`. Prompt caching enabled only when model is `anthropic/*`. `profileBlock` (asker-only) passed as `userContext`.
- **People/directory** `src/people/directory.ts`: `Profile` = {email, nickname, fullNameTh/En, position, org, department, team, rank, startDate, supervisor, employmentType?}. Functions: `refreshDirectory` (Graph→Redis, /refresh only), `lookupProfile(email)` (mem→Redis, never Graph), `renderProfileBlock` (asker-only block), `getResignedEmails`. **No `searchPeople` / `getPublicProfile`. No product/ownership field. `employmentType` column parsed defensively but not yet populated by HR.**
- **Teams channel** `src/channels/teams.ts`: commands = `/refresh` (admin), `/clear`|`/reset`|Thai clear phrases (anyone). Admin auth = `adminEmails()` from `KB_ADMIN_EMAILS` env, **email allowlist only** — no AAD group/object-id check (though `activity.from.aadObjectId` is available). Feedback buttons → `scoreTrace`. Identity via `TeamsInfo.getMember` → email (cached per warm instance). **No `/insight`.**
- **Observability** `src/obs/langfuse.ts`: Langfuse SDK; deliberately no `flushAt:1` (serverless), single awaited `flushObs()`. `startTrace/span/generation/update`, `scoreTrace`.
- **Analytics script** `scripts/analyze-langfuse.mjs`: pulls `GENERATION` observations via **Langfuse public REST API** (`/api/public/observations?type=GENERATION`, Basic auth, `limit=100` pagination). Computes p50/p95 latency, cost, tokens, cacheHitRate, per-generation-name + per-trace rollup. **Does NOT compute** users, repeat users, intent mix, UNKNOWN taxonomy, truncation, one-shot rate, error rate, data completeness, timezone handling, dedup/late-event handling.
- **Env** `src/env.ts`: models, Langfuse keys, Upstash, Outline, `KB_ADMIN_EMAILS`, Azure Bot (`AZURE_BOT_ID/SECRET/TENANT_ID`), Directory (`DIRECTORY_DRIVE_ID/ITEM_ID/SHEET`), `BROADCAST_CAMPAIGN`, `CRON_SECRET`.
- **Deploy** `vercel.json`: `maxDuration: 60` for `api/**/*.ts`; `includeFiles` KB + fallback prompts; **one** cron `/api/broadcast` daily `0 1 * * *` (08:00 ICT). Build = `npm run typecheck`.
- **API routes**: `api/teams.ts`, `api/chat.ts`, `api/broadcast.ts`.
- **State/store**: Upstash Redis via `src/store/redis.ts#getRedis` — used for KB, directory, history, rate limit, greet dedupe, intro claim, broadcast roster. Only durable store available for a job queue/status.
- **Tests/eval**: **no unit-test runner** (no vitest/jest in package.json). `scripts/run-smoke.mjs`, `scripts/run-eval.mjs` (LLM-judge over `test-cases/bob-eval-hr.jsonl`), `test-cases/bob-smoke-20.jsonl`. Eval calls OpenRouter → **costs money**.

## Verified counts (repo is source of truth)
- `test-cases/bob-smoke-20.jsonl` = **20** cases (matches spec "seed 20").
- `test-cases/bob-eval-hr.jsonl` = **32** cases (spec says "regression 31" — drift of +1; do not force to 31).

## Baseline (WP-01 start)
- `npx tsc --noEmit` → **PASS** (2026-07-11).
- No `lint` script. No unit-test script. `build` = `tsc -p tsconfig.json`. Eval/smoke are LLM-billed → not run in discovery.

---

## Assumptions (UNVERIFIED — do not treat as fact)
- Vercel plan tier (Hobby vs Pro) and real `waitUntil` behavior at 60s cap — **spike required** before choosing async-job architecture.
- Whether Teams bot in the production channel can send file attachments — **delivery spike required** (spec §2.5).
- Langfuse trace metadata is rich enough to derive intent/UNKNOWN/truncation per-turn — need to inspect a real trace payload (`--raw`). The pipeline DOES stamp `metadata.category`, `confidence`, `outputTokens`, `kbSelect` on the trace `update`, so intent/truncation MAY be derivable from TRACE metadata rather than GENERATION rows.
- Azure AD app has group-claim / directory-read scope needed for admin group auth — **G1 auth spike**.
- HR will add the "product/ownership" + "employment status" columns (People Connector data contract) — **G0**.

## Conflicts with the spec (report, don't silently fix)
1. "normalize" pipeline stage does not exist as a discrete step — the invariant to preserve is `precache → router → domainBot → finalize`.
2. Regression suite is 32 cases, not 31.
3. Admin auth today is email-only; spec mandates AAD object-id/group as primary. This is a *planned* gap (G1), not a bug to patch mid-discovery.

---

## Implementation State (§7.5 — read/update this first every session)

| Field | Value |
|---|---|
| Current Work Package | `WP-10 Analytics Foundation` — **core complete** (pure aggregation lib + golden fixtures + tests + CLI wiring). Next = `WP-11 Privacy & Report Schema` |
| Gate / approval | G0 (HR/data governance) **Pending**; G1 (spikes) **Pending**; all others Pending |
| Branch + base commit | `main` @ `ab65c7c` (WP-00/01/10 changes uncommitted in working tree) |
| Verified architecture | Architecture map above + Langfuse `/api/public/traces` shape confirmed from `langfuse-core` types (`TraceWithDetails`: trace-level `latency` s, `totalCost` USD, `userId`, `sessionId`, `metadata`, `tags`; query params `fromTimestamp`/`toTimestamp`, paginated `page`/`meta.totalPages`). |
| Changed files | No feature/runtime code. Added: `src/analytics/langfuse.ts` (pure core + thin I/O), `test-cases/analytics-fixture.json`, `test/{holidays,precache,directory,analytics}.test.ts`, `scripts/insight-report.mjs`, `docs/implementation/{WP-00-discovery,metric-contract}.md`, `package.json` (+`test`,`insight:report`). |
| Commands run | `tsc --noEmit` → PASS. `npm test` → **25/25 PASS** (16 characterization + 9 analytics golden). eval/smoke NOT run (LLM-billed). `insight:report` NOT run (needs live Langfuse creds). |
| Decisions | Aggregate from **traces** (not observations) — cost/latency are trace-level, so no observation join. Pure core / thin I/O split for testability; `fetch` injectable. **Left `analyze-langfuse.mjs` untouched** (proven generation-cost view) and added `insight-report.mjs` for the contract metrics — folding the old script fully into the lib is a tracked follow-up (needs its runner `node`→`tsx`). No hashing in WP-10: report is counts-only, no per-user rows. |
| Open assumptions | `[A]` fields in Metric Contract still want a one-time live-payload sanity check (`analyze-langfuse.mjs --raw`), esp. error-rate traceability + late-event cursor. Vercel tier/`waitUntil`; Teams file-attach; AAD group auth; HR columns. |
| Risks / known limitations | UNKNOWN not split (injection vs no-knowledge) — needs a new trace tag (WP-11/domainBot). `channel` read positionally from `tags[0]`. Async job 60s cap → maybe QStash (WP-12/G1). |
| Next safe step | **WP-11**: redaction pipeline (names/emails/phone/emp-id/URL/token/sensitive text) applied to sampled `trace.input` before any LLM sees it, + structured report schema (6 sections, evidence IDs) + renderer, with unit tests. Offline, no gate. Then WP-12 (job/auth/delivery) needs **G1** spikes. |
| Rollback | All changes are docs + additive tests + a new unused lib/script — nothing is wired into the running pipeline. `git checkout -- .` reverts with zero runtime impact. |
