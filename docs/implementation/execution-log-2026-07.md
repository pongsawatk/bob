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
