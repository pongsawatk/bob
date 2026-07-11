# Metric Contract — v0.1 (DRAFT, WP-01)

The single definition of every number the Continuous Improvement Analytics report emits.
WP-10 must implement exactly this; if a definition is wrong, change it **here first** (bump the version), then the code. Numbers are only comparable across weeks if this contract is frozen.

Status: **DRAFT — needs sign-off** (Jor / data owner). Baseline `61 users / 169 turns / 59% one-shot` (spec) is usable as a fixture **only after** confirming it was computed with the same filters below.

Grounding legend: **[V]** verified in code that writes the field · **[A]** assumed, must confirm against a real Langfuse payload (`analyze-langfuse.mjs --raw`) in WP-10.

---

## 0. Data source & keys
- Source: Langfuse **traces** (one per user turn) + their child **generations** (`router`, `domain:<cat>`). Pulled via public REST API `GET /api/public/observations` and `/api/public/traces`, paginated. **[V]** (observations) / **[A]** (traces endpoint shape).
- Trace shape written by `src/pipeline/index.ts`: `id`, `name:"bob-chat"`, `userId`, `sessionId`, `input`, `metadata.{category,confidence,hasProfile,latencyMs,inputTokens,outputTokens,cacheReadTokens,kbSelect,timings}`, `tags:[channel, category, "llm"|"precache"]`. **[V]**
- **Analytics key = pseudonymous.** Never use email/name as the grouping key in output. Hash `userId` → short id for the report. **[V that userId today is email-or-aadId]**

## 1. Timezone & window
- Timezone: **Asia/Bangkok** for all day/week bucketing and boundaries. (Confirmed correct+inclusive by `holidays.test.ts`.)
- Window `Nd` = the last N×24h ending at request time, **inclusive of the start instant, exclusive of the end**? → **DECIDE**: use `[now-Nd, now)`. Comparison window = the immediately preceding `[now-2Nd, now-Nd)`.
- `/insight 7d|14d|30d` only. `/insight` alone = `7d`. **[V: spec §2]**

## 2. Traffic inclusion / exclusion
- **Exclude test/bot traffic** before any metric:
  - `userId ∈ {"eval","dev-user"}` (from `run-eval.mjs`, `index.ts` dev server). **[V]**
  - Any future CLI/smoke sender ids → maintain an explicit denylist constant.
  - **DECIDE**: is `channel != "teams"` excluded from production metrics? (chat.ts test endpoint sets no channel → defaults `"teams"`; may pollute). **[A]**
- Include only traces with `name == "bob-chat"`. **[V]**

## 3. Core metrics (all computed in code, never by the LLM)
| Metric | Definition | Field | Grounding |
|---|---|---|---|
| Turns | count of included traces | trace | [V] |
| Unique users | distinct `userId` after exclusion | `trace.userId` | [V]* |
| Sessions | distinct `sessionId` | `trace.sessionId` | [V] |
| Repeat users (≥2 days) | users active on ≥2 distinct Bangkok calendar days in window; target 25–30% | derive from userId×day | [V] |
| One-shot rate | sessions with exactly 1 turn ÷ sessions | group by sessionId | [A: define "one-shot" = session-len 1 vs "no follow-up within X min"] |
| Intent mix | share of turns per `metadata.category` | `metadata.category` (or tag) | [V] |
| UNKNOWN | turns with `category=="UNKNOWN"` | metadata.category | [V] |
| UNKNOWN split | "genuine no-knowledge" vs "injection blocked" | **NOT derivable today** — no tag distinguishes them | [gap → WP-10/domainBot must add a tag, or classify heuristically; until then report combined + flag] |
| Truncation | turns where a domain generation's `usage.output ≥ model cap` (HR 1300, PRODUCT 2000, GENERAL 800) | generation usage.output | [V caps in domainBot.ts] |
| p50/p95 latency | percentiles of `metadata.latencyMs` (end-to-end incl. precache) | `trace.metadata.latencyMs` | [V] |
| Error rate | traces that errored ÷ total | **[A]** — confirm errored turns produce a trace (onTurnError path may not) | [A] |
| Cost | Σ generation `totalCost`, currency **USD** | generation cost | [V] |
| Cache hit rate | domain generations with `cacheReadTokens>0` ÷ LLM domain generations | metadata.cacheReadTokens | [V] |
| Feedback | 👍/👎 score events `name=="user-feedback"` (1/0) | trace score | [V] |

\* userId is **email when resolvable, else aadObjectId** (`teams.ts`) — a mixed key. Contract: treat both as the identity; note in report that a small number of turns may key on aadId (getMember failures) and could slightly inflate unique-user counts. **[V]**

## 4. Data-quality / completeness
- `completeness = included traces with non-null {category, latencyMs} ÷ included traces`.
- If `completeness < THRESHOLD` (**DECIDE**, propose 0.9) → report **partial-data warning**, suppress decision-grade conclusions (spec §4.5).
- **Duplicate traces**: dedupe by `trace.id`. **Late events**: a trace whose `timestamp` falls in-window but was ingested after the previous report — record `source window + ingest cursor` so re-runs are reproducible. **[A: confirm Langfuse exposes a stable createdAt/updatedAt]**

## 5. Redaction (before ANYTHING reaches the analysis LLM) — see WP-11
Redact from any sampled `trace.input`/output: names, emails, phone numbers, employee ids, URLs/tokens, and free-text sensitive queries. Only **aggregates + redacted samples with evidence IDs** go to the model. Raw `trace.input` never leaves code. **[V: pipeline already keeps profile content out of traces; input text itself is stored raw in Langfuse → must redact on read]**

## 6. Open decisions (block G2, not WP-10 coding)
1. Window boundary convention (half-open `[start,end)` proposed).
2. One-shot definition (session-length vs follow-up-gap).
3. Non-Teams channel inclusion.
4. Completeness threshold value.
5. How to split UNKNOWN (new tag vs heuristic).
6. Confirm baseline `61/169/59%` used these exact filters before treating it as ground truth.

---
*Consumed by: WP-10 (`src/analytics/langfuse.ts` aggregation) and its golden fixtures. Update the version header on any change.*
