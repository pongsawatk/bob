# G1 Technical Spikes — runbook & results

Gate **G1** (spec §6) requires proving four assumptions before committing WP-12 architecture.
A coding agent may **draft + run read-only** spikes and record evidence; it may **not** approve G1
or deploy/grant permissions — that's Jor/admin (§7.6). Fill the Result column, then decide.

| # | Spike | Script | Touches | Who runs |
|---|---|---|---|---|
| 1 | Langfuse pagination + trace schema | `scripts/spike-langfuse.mjs` | read-only Langfuse | ✅ done (agent) |
| 2 | Vercel duration + detached work | `api/spike/duration.ts` | deploy + prod config | Jor |
| 3 | Teams report delivery | `scripts/spike-teams-delivery.mjs` | sends a real DM (to self) | Jor |
| 4 | Azure AD group authorization | `scripts/spike-aad-auth.mjs` | read-only Graph | Jor (or agent w/ OK) |

---

## 1. Langfuse — ✅ RESOLVED (2026-07-11)
`npx tsx scripts/spike-langfuse.mjs 7`

- **Pagination works**: 375 raw traces over 7d, 4 pages joined via `page`/`meta.totalPages`.
- **All Metric-Contract `[A]` fields present** on real traces: trace-level `latency`(s), `totalCost`(USD), `userId`, `sessionId`, `input`, `metadata.{category,outputTokens,latencyMs,channel,confidence,cacheReadTokens,kbSelect,...}`, `tags`.
- **Finding — tags are alphabetically sorted** by Langfuse (`["HR","llm","teams"]`), so `tags[0]` is NOT the channel. → fixed `normalizeTrace` to read `metadata.channel`.
- **Finding — the traces endpoint is rate-limited (429)** with a hint to use `/api/public/v2/observations` for high volume. → `fetchTraces` now backs off on 429/Retry-After; the job must fetch with `limit=100` (fewest requests).
- **Data quality**: 375 raw → 200 after dedupe+exclusion (175 dropped, mostly `eval` test traffic); 0 missing category; 13 missing latency → completeness ≈93.5% (> 0.9 floor).
- **Cost reality check**: ~$5.98 / 7d (post-broadcast) — far above the old "$3–5/month" guess. Set the SLO/budget from measured data, not that estimate (spec §6.8).

## 2. Vercel duration / detached work — ⏳ PENDING (Jor)
Deploy, then with `CRON_SECRET` set:
```
curl -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/spike/duration?mode=sync&run=A"
curl -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/spike/duration?read=A"      # last heartbeat = real cap
curl -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/spike/duration?mode=detach&run=B"
curl -H "Authorization: Bearer $CRON_SECRET" "$BASE/api/spike/duration?read=B"      # did detached work continue?
```
Proves: (a) true `maxDuration` cap (60s configured — does a bump stick on this plan?), (b) whether fire-and-forget survives the response. **Decision:** if a full `/insight` run (fetch + LLM analysis) can't finish under the cap, or detached work is frozen → use **QStash/queue** from MVP (spec §2.4). **Result:** _[cap = __s; detached continued? __]_ · Remove the route after.

## 3. Teams delivery — ⏳ PENDING (Jor)
`npx tsx scripts/spike-teams-delivery.mjs --to <YOUR_AAD_OBJECT_ID>` (DM BOB once first so a convref exists).
Sends 4 methods to you; then eyeball the chat. Proves what actually renders in the prod 1:1 channel.
**Decision:** pick the delivery order (summary card → secure-link card → file-consent if it works → chunked text).
**Result:** _[card __ · link __ · file-consent __ · chunked __]_

## 4. Azure AD group auth — ⏳ PENDING
`npx tsx scripts/spike-aad-auth.mjs --email you@builk.com [--group <GROUP_OBJECT_ID>]`
Proves whether the bot app can read group membership (for AD-group admin gating) or 403s (→ grant
`GroupMember.Read.All`/`Directory.Read.All` + consent, or keep the email allowlist). The app currently
holds `Sites.Read.All` (for the HR sheet); group read may not be consented yet.
**Result:** _[resolve user __ · read groups __ · verdict __]_

---

### After G1
With results in hand, WP-12 can commit: job model (inline vs QStash), delivery path, and the admin
gate (AD group id vs email fallback). Then create the analysis prompt in Langfuse (label `production`).
