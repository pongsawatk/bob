# Execution Log — BOB Improvement Execution Plan (Notion, 2026-07-14)

Plan: Notion "BOB Improvement Execution Plan — Code, Tests & Langfuse Prompts".
One section per Work Package: files changed, behavior changed, tests, prompt version/label, risks, rollback.

---

## WP-00 — Discovery & Baseline (no behavior change)

Date: 2026-07-15 · Branch `main` @ `7599184` · working tree clean at start.

### Architecture map (verified against runtime, with symbols)

**Production PEOPLE path (natural chat, everyone):**

```
Teams activity
→ src/channels/teams.ts#handleTeamsRequest
   · aadId   = activity.from.aadObjectId ?? activity.from.id     (teams.ts:327)
   · email   = resolveEmail(ctx, aadId)  → TeamsInfo.getMember   (teams.ts:61-75, 341)
   · userId  = email || aadId                                    (teams.ts:342)
→ src/pipeline/index.ts#runPipeline({ message, userId, ... })
→ router (category PEOPLE)                                       (index.ts:106)
→ handlePeopleQuery(message, defaultPeopleDeps())                (index.ts:109)  ← identity DROPPED here
→ extractIntent (LLM) → evaluatePolicy → retrieve → compose (LLM + postCheck)
→ trace.update(tags:[channel,"PEOPLE","llm"])                    (index.ts:124)
```

`/people` (admin debug, `src/channels/people.ts`) is a secondary path; it *does* receive
`{ aadObjectId, email }` for the admin check but likewise drops it at `people.ts:38`.

### Root-cause table

| # | Observed | Hypothesis | Verified |
|---|---|---|---|
| P0-1 | Self-reference rc=0, 32/32 turns | connector never receives requester identity | **VERIFIED.** `handlePeopleQuery(query, deps)` (`connector.ts:55`) has no identity parameter. `runPipeline` holds `userId` (= canonical email) but passes only `message` (`index.ts:109`). Downstream, `REPORTING_LINE` needs `ref = personRef \|\| topic`; for "หัวหน้าฉันคือใคร" no name is typed → `ref` empty → `if (!norm(ref)) return empty({suggestCorrection:true})` (`search.ts:165`) → rc=0. Deterministic, not an LLM flake. |
| P0-2 | DX+QA → 20 (should be 5) | multi-filter ignored | **VERIFIED.** `SearchParams` (`pcTypes.ts:41`) has only `{topic, team, bu, personRef}` — **there is no `role` field**, so the role constraint is discarded at the LLM boundary before retrieval. `TEAM_ROSTER` then matches `team` only and caps at `PC_CONFIG.TEAM_ROSTER_MAX`. AND-semantics never had a chance to run. |
| P0-3 | DX rc=20 but responder says "ไม่พบ DX" | responder free to contradict retrieval | **VERIFIED.** `postCheck` (`compose.ts:71`) only guards *additive* leaks (emails/names not in results). Nothing checks the *negative* direction, so an LLM "no result" sentence passes the guard untouched. |
| P0-4 | Truncation misleads | `total` never reaches responder | **VERIFIED.** `retrieve` returns `total` (`search.ts:159`), but `connector.ts:82` passes only `response.results` to `compose`; `templateFallback` prints `results.length` (`compose.ts:102`). 29 DX members render as "พบ 20 คน". |

### Identity claims — risk register item 1 RESOLVED (not a blocker)

- Available: `activity.from.aadObjectId`, `activity.from.name`, and email/UPN via
  `TeamsInfo.getMember` (`teams.ts:66-67`), lowercased + cached per warm instance.
- Directory has **no AAD object-id column** (`Profile`, `directory.ts:14`) → join by
  **canonical company email**, exactly as the plan's WP-01 §2 prescribes. OID→email
  mapping stays a future enhancement.
- Precedent already in production: `lookupProfile(email)` → `renderProfileBlock` injects
  the asker's own profile into HR/GENERAL turns (`teams.ts:349`). Identity binding by email
  is established, not new.

### ETL boundary — confirmed, plan premise partially stale

`parseRows` (`directory.ts:118-171`) **already** handles the `พนักงานลาออก` divider explicitly
(`directory.ts:148`): rows below it go to `resigned: string[]`, never into `active`.
`refreshDirectory` refuses to publish an empty parse (`directory.ts:197`). So WP-04's
"Parser ต้องเข้าใจ section marker" is **already done**; WP-04's real remaining gaps are
email-uniqueness validation, NFKC/NBSP normalization, supervisor-reference validation,
and the freshness stamps.

### Prompt inventory

**Langfuse-managed** (live, loader `src/prompts/langfusePrompts.ts#getPrompt`, hardcoded
`?label=production`, 60s cache, falls back to `prompts/fallback/<name>.txt` on any error):

| name | versions | labels |
|---|---|---|
| `router` | 1,2,3 | latest, production |
| `hr` | 1,2,3 | latest, production |
| `general` | 1,2,3 | latest, production |
| `product` | 1,2 | latest, production |
| `insight-analysis` | 1,2,3 | latest, production |

**Inline (NOT in Langfuse)** — matches the plan's assumption for Prompt B/C:
- `INTENT_SYSTEM_PROMPT` — `src/people/intent/extract.ts:19`
- `RESPONDER_SYSTEM_PROMPT` — `src/people/connector.ts:20`

**Label capability (risk register item 6):** only `latest` + `production` exist today.
Langfuse v2 accepts arbitrary labels on create, and the loader reads `production` **only**,
so publishing a new version labelled `candidate` cannot affect production. Staged
promote is therefore viable: create `candidate` → test by explicit version → move
`production` via `PATCH /api/public/v2/prompts/{name}/versions/{version}`.

### Baseline (2026-07-15)

| Check | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | **PASS** |
| `npm test` (`node --import tsx --test test/*.test.ts`) | **161/161 PASS**, 0 fail |
| `npm run build` | not re-run; `build` == `tsc -p tsconfig.json`, same compiler input as typecheck |
| lint | **no lint script exists** (see conflicts) |
| `test-cases/bob-eval-hr.jsonl` | 32 LLM-judged cases — billed, not run in discovery |

### Conflicts with the plan (reported, not silently fixed)

1. **No lint script.** Plan's checkpoints say "รัน lint + typecheck + build". `package.json`
   has no `lint`. Treating typecheck+build as the static gate; not adding a linter
   mid-plan (unrelated change, rule 3).
2. **"161 cases" is the unit-test suite, not an eval.** The plan says "regression/eval 161 cases".
   `npm test` = 161 unit/integration tests (free, fast). The LLM-judged eval is 32 cases and
   costs money. Both tracked separately.
3. **`src/channels/broadcast.ts` uncommitted — stale.** Plan's "Repo hygiene ก่อนเริ่ม" says it has
   uncommitted edits. It does not: committed at `7599184`, working tree clean. Nothing to separate.
4. **WP-04 section-marker parsing already implemented** (see ETL boundary above).
5. **WP-01 items 8–9 already implemented.** `findSupervisor` (`profileStore.ts:59`) is already
   deterministic and returns `none`/`unresolved`/`resolved` without guessing; `tenure`
   (`profileStore.ts:103`) already computes from `startDate` in Asia/Bangkok wall-clock and does
   not use any snapshot column. WP-01 reduces to **wiring identity + SELF targetType**.

### Governance gate (WP-01) — satisfied for self-only

`docs/implementation/G0-governance-checklist.md` §2.1 puts **"หัวหน้า (Supervisor), วันที่เริ่มงาน/อายุงาน"**
inside the directory allowlist and scopes it to answering *about colleagues* (For-All data HR
already publishes company-wide). Self-reference is a strict subset of that. Production already
serves both fields to the asker about themselves via `renderProfileBlock` (`directory.ts:297-315`),
which explicitly instructs: "ตอบข้อมูลในโปรไฟล์นี้ให้เจ้าตัวได้ถ้าถูกถามตรง ๆ (เช่น อายุงานของฉัน)".

→ **WP-01 self-only proceeds.** The plan's fallback position ("ถ้ายังไม่อนุมัติให้จำกัด self-only ไปก่อน")
is exactly the scope being built. The plan's separate ask — retroactively confirming that BOB
answered *other people's* tenure in production — remains an open item for HR and is **not**
resolved by this WP.

### Deliverable status

WP-00 complete. No behavior code touched. Next: WP-02 (query contract) per Wave 1.

---

## WP-02 — Deterministic query contract & multi-filter (P0) · commit `62625ab`

**Changed:** `src/people/pcTypes.ts` (+`role`, +`countOnly`), `src/people/retrieval/roles.ts` (new), `src/people/retrieval/search.ts`, `test/pcQueryContract.test.ts` (new, 14).

**Behavior:** role constraints are now ANDed with team/bu instead of discarded. `countOnly` answers the exact total with no roster sent to the model. `retrieve()` returns `totalMatches/shownCount/truncated/candidateIds/filtersApplied` from one paging helper, so totals cannot disagree with rows. `total` → `totalMatches` (field rename; one test updated).

**Risk / rollback:** revert the commit. The role taxonomy is additive — an unknown role still filters by raw substring, so no query that worked before returns less.

## WP-03 — Response guard & pagination (P0) · commit `fa87f38`

**Changed:** `src/people/responder/compose.ts`, `src/people/connector.ts`, `test/pcResponseGuard.test.ts` (new, 14).

**Behavior:** `validateResponse()` judges the answer against the retrieval result — non-empty candidates forbid a no-result claim, `countOnly` requires the exact total, a truncated page must state both numbers. Failure ships the deterministic template and logs `RESPONDER_VALIDATION_FAILED` (reason code only). Count questions skip the responder LLM entirely.

**Risk:** the no-result phrase regex is deliberately broad; a false positive costs a template instead of prose (fail-safe), never a wrong answer.

## WP-01 — Self-identity resolution (P0) · commit `274c6e1`

**Changed:** `src/people/identity.ts` (new), `pcTypes.ts` (+`targetType`, +`TENURE`), `intent/extract.ts`, `retrieval/search.ts`, `connector.ts`, `pipeline/index.ts`, `channels/teams.ts`, `channels/people.ts`, `env.ts`, `test/pcSelfIdentity.test.ts` (new, 20).

**Behavior:** requester identity binds on tenant-verified canonical email, carried as a typed `PeopleContext`. Self detection is deterministic — Thai has no word boundaries, so a boundary regex read the CTA's own phrasing ("หัวหน้าฉัน") as "not self". Identity failures answer distinctly (`IDENTITY_NOT_FOUND` / `IDENTITY_AMBIGUOUS` / `PROFILE_INACTIVE`) instead of "ไม่พบ". "ทีมผมมีใครบ้าง" resolves the asker's team and answers it as a roster.

**Prompt:** router `candidate` v4 (see Prompt A) — required for tenure questions to reach PEOPLE at all.

**Rollback:** `PEOPLE_SELF_ENABLED=0` disables self-resolution only; every other People answer keeps working. `PEOPLE_ENABLED=0` remains the whole-feature kill-switch.

**Governance:** self-only is inside G0 §2.1. Answering *other people's* tenure predates this work and still needs HR retroactive confirmation — **open, needs a human**.

## WP-05 — Alias & ambiguity layer · commit `17c2feb`

**Changed:** `src/people/retrieval/aliases.ts` (new), `retrieval/search.ts`, `connector.ts`, `test/pcAliases.test.ts` (new, 13), `test/pcTeamRoster.test.ts` (1 superseded).

**Behavior:** aliases carry a matcher, not a registry spelling — the live directory supplies real values, so ambiguity is discovered from data ("ทีมบัญชี" asks which team only when two exist) and a renamed team degrades to raw match rather than a confident zero. Alias-resolved terms match exactly so "Accounting" cannot swallow "Finance And Accounting".

**Superseded test documented:** "ทีมบัญชี" used to return one member of a two-person team because substring matched บัญชี inside one person's Thai position while the other's English "Accountant" missed.

## WP-04 — Directory ETL & data quality · commit `a699ad3`

**Changed:** `src/people/directory.ts`, `connector.ts` (freshness footer), `test/pcEtlQuality.test.ts` (new, 18).

**Two silent defects found:**

1. The section divider matched `ลาออก` in *any* cell — a position or note containing the word would move that person and everyone below them into the resigned section, dropped with no error. Only an email-less row can be a divider now.
2. **The plan's specified NFKC breaks Thai** — it splits SARA AM (U+0E33), so the `/ตำแหน่ง/` column regex stops matching the header and the position column vanishes from every profile, taking the WP-02 role filter with it. Caught by an existing test. Uses NFC + an explicit width fold.

**Behavior:** duplicate-email + supervisor-reference validation; publish validates the whole snapshot first and refuses on a resigned leak or a >33% roster drop (relative — a hard-coded headcount goes stale the first time HR hires). Answers cite "ข้อมูลทะเบียน ณ <date>"; no stamp → no footer.

## WP-07 — Observability & error taxonomy · commit `c58ced8`

**Changed:** `connector.ts`, `pipeline/index.ts`, `intent/extract.ts`, `pcTypes.ts`, `test/pcObservability.test.ts` (new, 10).

**Behavior:** intent + responder now log child generations with usage/cost/latency — PEOPLE previously logged none, so the only two-LLM-call category reported no cost. `usedFallback` split into `intentFallback`/`retrievalFallback`/`responderFallback` + an `errorStage` every answerless turn carries exactly one of. Per-stage timings on the trace. `usedFallback` retained for existing dashboards.

**Plan conflict:** the plan's "taxonomy compatibility" risk (adding `TENURE` breaks `/insight`) is **false**. `normalizeIntent` (`src/analytics/langfuse.ts:107`) normalizes the router *category*; nothing in `src/analytics/` or the metric contract reads `subIntent`. No analytics migration was needed.

## WP-06 — Follow-up context · commit `b9f9a8d`

**Changed:** `connector.ts`, `pipeline/index.ts`, `retrieval/search.ts`, `test/pcFollowUp.test.ts` (new, 7).

**Behavior:** conversation history (already in Redis, already loaded per turn) now reaches `extractIntent`, which has accepted an `ExtractOptions.history` since it was written. `FOLLOW_UP_FILTER` resolves through the TEAM_ROSTER path instead of returning `empty()`.

**Not done:** `context/store.ts` stays unwired — it is an in-memory Map and Vercel does not guarantee the same warm instance across turns, so it would pass tests and work intermittently in production. Cursor pagination ("มีคนอื่นอีกไหม") needs durable state.

## Prompts A / B / C · commits `16bf067`, `4147915`, `d3eea33`

| prompt | production | candidate | state |
|---|---|---|---|
| `router` | **v3 (unchanged)** | **v4** | held — see below |
| `people-intent` | **v1 (promoted)** | v1 | live-on-deploy |
| `people-responder` | **v1 (promoted)** | v1 | live-on-deploy |

**Prompt A found a code bug:** the JSON reminder appended to every router user message listed `HR|PRODUCT|GENERAL|UNKNOWN` while the system prompt offered PEOPLE. That reminder is load-bearing (without it the router model returns prose instead of JSON). Fixed in `src/pipeline/router.ts`.

Golden eval against the live router model: **candidate 22/22, current production 20/22** — production sends both tenure phrasings ("ผมทำงานมากี่ปี กี่วันแล้ว", "ฉันเข้างานวันไหน") to HR. HR/PRODUCT/GENERAL boundaries and both injection cases hold on the candidate.

**Router v4 must NOT be promoted before the code deploys.** Tenure questions are answered *correctly today* by the HR path via `renderProfileBlock`. Promoting first moves them to PEOPLE while the deployed connector still drops identity → rc=0, i.e. it breaks a working answer. Correct order: deploy code → promote router v4 → smoke test. Rollback: `npm run prompt promote router 3`.

`people-intent`/`people-responder` were safe to promote now precisely because they are new: no production label existed and the deployed code still uses its inline constants, so they are inert until the code ships — at which point the text is byte-identical to the fallback (pinned by contract tests).

---

## State at end of session

| | |
|---|---|
| Branch | `main`, **not pushed** — nothing is deployed |
| Tests | **267/267 pass** (baseline was 161) · typecheck + build clean |
| Eval (32 LLM-judged HR cases) | **not run** — billed; unaffected by these diffs but should run before rollout |

### Blocked / needs a human

1. **Deploy** (`git push`) — outward-facing; not done without a direct ask.
2. **Router v4 promotion** — after deploy, in that order.
3. **HR retroactive confirmation** that BOB answering *other people's* tenure (pre-existing behavior) is in scope.
4. **WP-09 rollout** (shadow → admin canary → 5–10 users) and the round-3 broadcast — the plan gates both on human approval.

### Not built (with reasons)

- **WP-08 performance/cost:** the two biggest levers landed as side effects — counts and rosters no longer call the responder LLM at all (WP-03), removing a call from the p95 path. The HR-side work (cache telemetry, precache, truncation) needs the real provider/Langfuse cache fields the plan says to verify first, which needs a production pull.
- **WP-10.2–10.6:** did-you-mean, Teams deep-link buttons, suggestion chips, self profile card, no-result mining. All additive; 10.1 (freshness stamp) shipped with WP-04.
- **Cursor pagination:** needs durable per-conversation state (see WP-06).
