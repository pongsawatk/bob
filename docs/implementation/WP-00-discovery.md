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
| Current Work Package | **`/insight` (WP-00→13) COMPLETE + LIVE in production (admin-only)** as of 2026-07-11. Pipeline: `/insight [7d\|14d\|30d]` → QStash → worker (fetch→aggregate→analyze→deliver) → summary card + secure report link. Next session = **People Connector (WP-20+, blocked on G0)** OR **/insight v1.1** (see "Next session" below). |
| Gate / approval | G0 (People Connector) **Pending**. **G1 PASSED** (4 spikes). **G2 shadow PASSED**: `/insight 7d` == `npm run insight:report 7` byte-identical (guaranteed — both call `normalizeAll`+`aggregate`). |
| Branch + base commit | **`main` @ `cf46f16`** (all merged + pushed; `main` == `origin/main`). `main` deploys to Vercel project `bob`. |
| Verified architecture | See map above. `/insight` modules: `src/analytics/{langfuse,redact,report,analyze,job,queue,jobStoreRedis,reportLink}.ts`, `src/channels/{insight,insightDeliver}.ts`, `api/insight/{worker,report}.ts`, `prompts/fallback/insight-analysis.txt`. Core BOB pipeline `precache→router→domainBot` untouched. |
| Changed files (this session) | New /insight feature (above) + `test/{holidays,precache,directory,analytics,redact,report,job,insight,reportLink}.test.ts` + `scripts/{insight-report,insight-clear,insight-status,spike-*}.mjs` + `docs/implementation/*`. Edited: `src/{env,channels/teams,people/directory,analytics/langfuse}.ts`, `prompts/fallback/general.txt` (what's-new), `package.json` (+`@upstash/qstash`,`@vercel/functions`,`test` script). |
| Commands run | `tsc --noEmit` → PASS. `npm test` → **80/80 PASS**. `insight:report`/`spike-*` run live read-only. Production `/insight` verified end-to-end + G2 shadow. |
| Decisions | Models: **/insight analysis = `openai/gpt-5.6-terra`** (fast ~12s, valid JSON, under 58s cap; Sonnet-5 too slow @52s); **HR/Product stay `claude-sonnet-4-6`/Sonnet-5 — NOT changed** (prompt caching gates on `anthropic/`, eval-tuned). Job = **QStash queue, resumable page-by-page, windows pinned at creation**. Analysis `maxTokens=4000` (2k truncated JSON). Prompt = evidence-grounded guardrails; deadline-aware fallback to numbers-only. |
| Action items on Jor (pending) | (1) Paste the "what's new" block into the **Langfuse `general` prompt** (production) for no-deploy effect — repo has fallback baseline. (2) Optionally create the **Langfuse `insight-analysis` prompt** (fallback works meanwhile). (3) Fill the general prompt's social-proof slot with a real weekly top topic (or leave blank). (4) People Connector needs **HR/G0** (allowlist + 2 columns). |
| Next session — start here | **Option A — People Connector (WP-20+):** BLOCKED on G0. First deliverable = a **governance checklist + data contract** (allowlist fields, tenant auth, freshness/correction, deny-by-default) for HR to approve — no code until G0. NOTE: BOB currently CANNOT answer about other people (asker-only profile + explicit refusal rule in `renderProfileBlock:273`); do NOT claim otherwise. **Option B — /insight v1.1:** department breakdown (resolve dept via directory in worker), real topic clusters (T evidence), latency breakdown by intent/stage, low-base % polish (annotate/suppress % when previous base tiny), auto social-proof (feed /insight top-topic into the general prompt). **Housekeeping:** per-job token/sample caps + daily job limit + cost alert (spec §5) before heavy use; 2nd G2 shadow round (formality). |
| Activation gotchas (solved) | `QSTASH_URL` must match the account region (`https://qstash-us-east-1.upstash.io`, = Vercel region iad1) else "user not found in this region". QStash verify drops the url-claim check. `INSIGHT_ADMIN_GROUP_ID` gates via Graph `checkMemberGroups`. `scripts/insight-clear.mjs` resets stuck jobs; `insight-status.mjs <jobId>` reads a job record. `INSIGHT_ENABLED=1` arms it. |
| Rollback | `/insight` fully gated by `INSIGHT_ENABLED` (unset/`0` → inert; command falls through to normal pipeline). Core BOB behavior unaffected. |
