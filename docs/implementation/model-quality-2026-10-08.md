# BOB model and answer-quality release

Release implementation and runbook. Base commit: d01946a. Post-deployment evidence is stored separately under ignored test-results.

## Scope and decisions

- Preserve the primary answering model. The user selected **shadow only** on 8 October 2026: no pilot answers are sent to Teams.
- Compare Sonnet 5 Medium with Sonnet 5.5 Medium; Gemini 3.8 Flash Low and Haiku 5.5 Low are additional experimental arms. Haiku replaces the proposed GPT-6 Luna. Router remains unchanged.
- Jev 1.13 is advisory. It cannot approve an answer, send a message, override an IT citation/privacy guard, or trigger another model.
- HR prompt candidate v4 contains behavior instructions only; no KB contents or personal profiles were uploaded to Langfuse.
- Existing unrelated documents and audit artifacts are excluded from this release commit.

## Implemented

- Model-specific parameters, explicit effort, independently configurable People models, completion metadata and nullable unknown cost.
- Literal prompt substitution; source-grounded completeness, leave/pay distinctions and conditional entitlement guidance.
- Topic-scoped retrieval and chapter/link references; maternity vocabulary and annual-leave coverage.
- Atomic conversation-history append, conversation serialization, duplicate activity claims and reset epochs.
- Deterministic People rosters with requested English-name/contact fields.
- Redis-backed evaluation snapshots, QStash worker, budget reservations, human-review records and authenticated administration.
- Full-answer eval artifacts with KB/prompt hashes; unavailable judges produce UNREVIEWED.

## Evaluation controls

`POST /api/evaluation` requires `x-test-key` matching CHAT_TEST_KEY or the existing operations CRON_SECRET.

- `action: status`: configuration (identities masked), arms, budget counters and recent completed/pending records.
- `action: configure`: validated configuration containing mode, arm, pilotUsers, dailyMaxCalls, totalMaxCalls, dailyMaxUsd, totalMaxUsd, sampleRate and jevEnabled.
- `action: process, jobId`: drain a pending job if queue delivery failed.
- `action: get, jobId`: completed result; raw snapshots are never returned.
- `action: review, jobId, winner, comment`: record an actual human review. Winner is baseline/candidate/tie/unjudgeable.

The default mode is off. Authorized activation is shadow / sonnet55-medium, 12 extra generations per UTC day, 100 total generations, $2 daily and $10 total reservation limits, with advisory Jev enabled. A Jev review can add one Decisions API request per generation. These are inference safeguards, not a forecast of cost or a cap on hosting/queue charges. Each job reserves $1 atomically before calling; unknown billing retains the reservation. Context is limited to 160 KB of serialized input, output to at most 4096 tokens, and candidate provider prices to $4/$10 per million input/output tokens. Jobs expire after 24 hours, results after 7 days. The total ledger is release-specific and does not reset on a mode change. Interrupted running jobs are not inferred again.

The worker receives only a job ID through QStash. It replays the captured prompt, evidence, date, history and original user context against one challenger. It does not touch conversation history, answer caches or Teams delivery. Jev receives no profile block, only evidence/question/answer with known names, contact details, identifiers, URLs and token patterns redacted. Missing redaction data or context above the conservative limit means not_assessed; there is no silent truncation. Provider/model mismatch, incomplete output and fallbacks invalidate a comparison. Actual effort is recorded as unknown because the provider does not echo it.

Shadow candidate prompt caching is disabled while the primary retains normal caching. Compare their token/cache metadata before attributing cost differences to a model. Local paired replays disable caching on both sides.

Kill switch: set configuration mode to off. Queued workers recheck it before inference. A request already in flight can finish. To disable only Jev, set jevEnabled=false. Revert code and restore the previous HR production prompt version for a full rollback.

## Pre-release verification

- 335 local tests passed under Node 20; TypeScript and build passed. Tests include replay isolation, duplicate workers, interruption, budget refusal, endpoint authorization, reset cancellation and English directory fields.
- Synthetic calls reached all four requested models. Jev distinguished one supported and one contradicted synthetic answer. This is an API smoke test, not accuracy calibration.
- Initial paired replay: 8 scenarios, 28 model completions and one deterministic Timesheet answer, $0.6936845 reported generation cost. HR candidate v4 replay: 4 scenarios × 4 models, $0.4744803. All 44 model completions finished without API errors or length truncation. These are functional results, not a 44/44 correctness score.
- Agent review found maternity and annual-leave evidence available, but uneven answer quality remains: Sonnet 5 still used an overconfident sick-pay example before its caveat; Haiku's sick-leave wording can confuse leave entitlement with paid days. Sonnet 5.5 adds some unnecessary related details, and the Mac VPN follow-up repeats Windows steps before explaining the evidence gap. These findings support keeping the primary and collecting shadow comparisons, not declaring a model winner.
- Required release checks: verify the new Git SHA is READY and aliased, promote/read back HR v4, activate/read back shadow mode, exercise the signed queue, confirm primary vs candidate separation and budget counters, and inspect production errors. Record actual results in the local release report.

## Commands

- `npm test`, `npm run typecheck`, `npm run build`
- `node --import tsx scripts/model-smoke.mjs`
- `node --import tsx scripts/evaluate-models.mjs --hr-version 4 --max-usd 3`

Real-model outputs, source snapshots and endpoint credentials stay under ignored test-results; do not commit them. Do not interpret a model or Jev score as human-reviewed correctness. Compare category coverage, major errors, completeness, latency, fallback incidence and cost per accepted answer before changing production models.
