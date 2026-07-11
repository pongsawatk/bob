# WP-12 — /insight Activation Runbook

The code is complete and deployed but **inert** (`INSIGHT_ENABLED` unset). This runbook
turns it on. Do the steps in order; the feature stays off until the final step. All env
vars go on the canonical Vercel project **`bob`** (domain `bob-sidekick.vercel.app`), not
the `bob-sidekick` duplicate.

> ⚠️ **Never set Vercel env vars by piping through PowerShell** — CRLS get appended and
> break the build (documented failure). Use the Vercel dashboard UI, or `vercel env add`
> and paste the value when prompted.

## Prerequisites (already done)
- G1 spikes #1-#4 resolved (`docs/implementation/G1-spikes.md`).
- Code shipped, gated off. Name + structured-PII redaction wired into sample collection.

## Step 1 — QStash (durable queue)
1. Upstash console → **QStash** → copy **QSTASH_TOKEN** and the two signing keys
   (**QSTASH_CURRENT_SIGNING_KEY**, **QSTASH_NEXT_SIGNING_KEY**).
2. On Vercel project `bob` → Settings → Environment Variables (Production), add:
   - `QSTASH_TOKEN`
   - `QSTASH_CURRENT_SIGNING_KEY`
   - `QSTASH_NEXT_SIGNING_KEY`
   - `INSIGHT_WORKER_URL` = `https://bob-sidekick.vercel.app/api/insight/worker`
3. Redeploy (or let the next push deploy). No behavior change yet — still gated off.

## Step 2 — Admin AD group
1. Entra ID (Azure AD) → Groups → **New group** → Security → name "BOB Insight Admins".
2. Add yourself (and any other insight admins) as members.
3. Copy the group's **Object ID** → set Vercel env `INSIGHT_ADMIN_GROUP_ID`.
   - Fallback: if unset, admin gate uses `KB_ADMIN_EMAILS` (temporary).
   - Spike #4 confirmed the bot app can read membership via `checkMemberGroups`.

## Step 3 — Analysis prompt in Langfuse
1. Langfuse → Prompts → **New prompt** named exactly **`insight-analysis`**.
2. Paste the body of `prompts/fallback/insight-analysis.txt`, set label **`production`**.
   - Until this exists, the code auto-uses the fallback file, so this step is optional to
     start but recommended so non-devs can tune it without a redeploy.

## Step 4 — Turn it on
Set Vercel env `INSIGHT_ENABLED` = `1` (Production) and redeploy.

## Step 5 — Smoke test (in Teams, as an admin)
- `/insight` → expect an ACK with a jobId within a few seconds.
- `/insight-status <jobId>` → watch it move `queued → running → completed`.
- On completion: a summary card with an **เปิดรายงาน** button → opens the report
  (`/api/insight/report?...`) in the browser; token-gated, expires in 24h.
- Non-admin / `/insight 10d` / extra tokens → denial or usage message, no job created.
- Verify the report's Appendix samples show `[email]`/`[phone]`/`[name]` — no raw PII.

## Step 6 — WP-13 shadow validation (Gate G2)
Before broadcasting the feature: run `/insight 7d` and compare its numbers to the manual
`scripts/analyze-langfuse.mjs` / `insight-report.mjs` output for the same window, **≥2 rounds**.
Reconcile every discrepancy (confirm same timezone/filters). Only then consider wider rollout.

## Rollback
Unset `INSIGHT_ENABLED` (or set to `0`) and redeploy → feature fully inert again. No pipeline
or bot behavior is affected; the command falls through to the normal chat flow.

## Known limitations at activation
- Delivery = summary card + secure link → chunked-text fallback. **File upload not supported**
  (spike #3: needs a `fileConsent/invoke` handler — post-MVP).
- `RedisJobStore.update` is read-modify-write; safe because the queue serializes stages per
  job and `claimStage` dedupes duplicate deliveries.
- Per-job token/sample caps + daily job limit + cost alerting are not yet enforced (spec §5
  risk row) — add before heavy use.
