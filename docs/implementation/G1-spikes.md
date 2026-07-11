# G1 Technical Spikes — runbook & results

Gate **G1** (spec §6) requires proving four assumptions before committing WP-12 architecture.
A coding agent may **draft + run read-only** spikes and record evidence; it may **not** approve G1
or deploy/grant permissions — that's Jor/admin (§7.6). Fill the Result column, then decide.

| # | Spike | Script | Touches | Who runs |
|---|---|---|---|---|
| 1 | Langfuse pagination + trace schema | `scripts/spike-langfuse.mjs` | read-only Langfuse | ✅ done (agent) |
| 2 | Vercel duration + detached work | `api/spike/duration.ts` | deploy + prod config | ✅ done (Jor ran, agent drafted) |
| 3 | Teams report delivery | `scripts/spike-teams-delivery.mjs` | sends a real DM (to self) | Jor |
| 4 | Azure AD group authorization | `scripts/spike-aad-auth.mjs` | read-only Graph | ✅ done (agent) |

---

## 1. Langfuse — ✅ RESOLVED (2026-07-11)
`npx tsx scripts/spike-langfuse.mjs 7`

- **Pagination works**: 375 raw traces over 7d, 4 pages joined via `page`/`meta.totalPages`.
- **All Metric-Contract `[A]` fields present** on real traces: trace-level `latency`(s), `totalCost`(USD), `userId`, `sessionId`, `input`, `metadata.{category,outputTokens,latencyMs,channel,confidence,cacheReadTokens,kbSelect,...}`, `tags`.
- **Finding — tags are alphabetically sorted** by Langfuse (`["HR","llm","teams"]`), so `tags[0]` is NOT the channel. → fixed `normalizeTrace` to read `metadata.channel`.
- **Finding — the traces endpoint is rate-limited (429)** with a hint to use `/api/public/v2/observations` for high volume. → `fetchTraces` now backs off on 429/Retry-After; the job must fetch with `limit=100` (fewest requests).
- **Data quality**: 375 raw → 200 after dedupe+exclusion (175 dropped, mostly `eval` test traffic); 0 missing category; 13 missing latency → completeness ≈93.5% (> 0.9 floor).
- **Cost reality check**: ~$5.98 / 7d (post-broadcast) — far above the old "$3–5/month" guess. Set the SLO/budget from measured data, not that estimate (spec §6.8).

## 2. Vercel duration / detached work — ✅ RESOLVED (2026-07-11)

Results (production project `bob`, domain `bob-sidekick.vercel.app`, `maxDuration: 60`):

| mode | result | verdict |
|---|---|---|
| sync (block in handler) | `FUNCTION_INVOCATION_TIMEOUT`; last heartbeat **58s** | hard cap ≈58–60s, real and enforced |
| detach (bare `void fn()`, unawaited) | heartbeat stayed **`null`** — not even the first checkpoint (elapsed=0) wrote | **unusable — 0% reliability**, work gets zero execution after the response is sent |
| `waituntil` (`@vercel/functions#waitUntil`) | heartbeat climbed to **58s** (read at +20s and again at +70s from fire time) | **works** — background work reliably continues past the response, but is bounded by the **same ≈58s ceiling** as a synchronous request. Not extra time, just a guarantee the work isn't killed immediately. |

**Conclusions for WP-12:**
1. **`waitUntil` is the correct primitive** to use — plain fire-and-forget must never be used for `/insight` background work (confirmed 0% reliable here).
2. **Total budget per invocation ≈55s usable** (58s observed ceiling, minus safety margin). This covers: ACK (~1–3s) + `waitUntil`-deferred work (fetch traces + redact + aggregate + LLM analysis + render + deliver).
3. **Real-world sizing** (from spike #1 data): a 7d fetch = 375 raw traces / 4 pages, ran in a few seconds; code-side aggregation is near-instant (pure functions, no I/O). The dominant unknown cost is the **LLM analysis call latency** (not yet measured) and a **30d fetch** under the confirmed rate limit (§1) — both could push past ~55s, especially with 429 backoff retries.
4. **Two viable architectures, tradeoff for Jor to pick** (§ Decision below).

### Decision needed — pick the WP-12 job architecture
- **Option A — `waitUntil` + continuation, no new vendor.** Command handler ACKs fast, `waitUntil` runs the job with an internal ~50s hard budget; if it can't finish (large window / slow LLM), persist partial state + `status: "needs-continuation"` to Redis and let `/insight-status` or a follow-up cron tick resume. Simpler, zero extra cost, but WP-12 must implement resumable/chunked fetch+analysis logic itself.
- **Option B — QStash/durable queue from MVP** (spec's own fallback, §2.4/§6). Each invocation gets a fresh ~58s budget; natural retry/backoff/idempotency comes from the queue. Adds a new vendor + minor cost, but matches the spec's explicit contingency ("หากรับประกันไม่ได้ให้ใช้ QStash/queue ตั้งแต่ MVP") and is less code to get right.

Once decided, remove `api/spike/duration.ts` and the `@vercel/functions` dep if Option B is chosen (Option A keeps both).

*(Side note from Jor: `README.md`/`docs/status.md` were separately updated by Codex on 2026-07-11 — confirmed `$BASE` used for this spike (`bob-sidekick.vercel.app`) is served by the canonical `bob` Vercel project with real env vars, not the duplicate `bob-sidekick` project. Spike results are trustworthy.)*

## 3. Teams delivery — ⏳ PENDING (Jor)
`npx tsx scripts/spike-teams-delivery.mjs --to <YOUR_AAD_OBJECT_ID>` (DM BOB once first so a convref exists).
Sends 4 methods to you; then eyeball the chat. Proves what actually renders in the prod 1:1 channel.
**Decision:** pick the delivery order (summary card → secure-link card → file-consent if it works → chunked text).
**Result:** _[card __ · link __ · file-consent __ · chunked __]_

## 4. Azure AD group auth — ✅ RESOLVED (2026-07-11)
`npx tsx scripts/spike-aad-auth.mjs --email pongsawat@builk.com`

- **App CAN read group membership**: `transitiveMemberOf` returned **35 group ids** for the user (HTTP 200). No new membership permission needed.
- **Caveat — group `displayName` is `null`**: the app reads membership (ids) but not group *properties/names*. Reading names would need `Group.Read.All`/`Directory.Read.All` + admin consent. **Not required** for gating.
- **Verdict:** `/insight` can gate on a **group object id** (Metric Contract req #2 satisfiable now). We match by id, never by name.
- **WP-12 implementation notes:**
  - Configure `INSIGHT_ADMIN_GROUP_ID=<guid>` (a new "BOB Insight Admins" security group Jor creates + adds himself to).
  - At command time use the lighter **`POST /users/{aadObjectId}/checkMemberGroups`** (body: `{groupIds:[INSIGHT_ADMIN_GROUP_ID]}`) instead of listing all 35 — one cheap call; `activity.from.aadObjectId` is already available in `teams.ts`.
  - Keep `KB_ADMIN_EMAILS` as the documented temporary fallback until the group is created (spec §2, req #2).

---

### After G1
With results in hand, WP-12 can commit: job model (inline vs QStash), delivery path, and the admin
gate (AD group id vs email fallback). Then create the analysis prompt in Langfuse (label `production`).
