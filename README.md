# BOB Sidekick — Builk One Buddy

> Internal AI Knowledge Assistant for Builk One Group · answers HR / Process / Product
> questions in **MS Teams** with citation-grounded answers, refusal rules for sensitive data,
> and a feedback loop for continuous knowledge improvement.

[![Status](https://img.shields.io/badge/status-live%20org--wide-brightgreen)]() [![Channel](https://img.shields.io/badge/channel-MS%20Teams-blue)]() [![Stack](https://img.shields.io/badge/stack-Vercel%20%2B%20OpenRouter%20%2B%20Langfuse-purple)]()

> 📌 **For current state, what's done, and what's planned → see [`docs/status.md`](docs/status.md).**
> This README is the quick orientation; `status.md` is the living source of truth.

---

## What is this?

BOB (**Builk One Buddy**) is an internal AI assistant for Builk One Group employees, reachable in
**MS Teams**. It routes each question (HR / Product / General), retrieves the relevant knowledge,
answers in Thai with source citations, refuses volatile/sensitive data (pricing, personal records),
and logs every turn to Langfuse for monitoring + feedback.

**Status:** 🟢 Live org-wide (rolled out 2026-06-06, 138 users). BOB is also the **reference
template** for a fleet of internal bots.

## Architecture (1-pager)

```
MS Teams ⇄ Azure Bot F0 (Single-Tenant) ⇄ Vercel /api/teams
                                              │
                        BOB Service (TypeScript, src/)
                        channel → rate-limit → pipeline:
                          precache → router → domainBot → normalize
                              │            │            │
                       Langfuse      Outline→Redis   Langfuse
                       (prompts)     (knowledge)     (trace/cost/score)
                              │
                       OpenRouter (Gemini + Claude, 1 key, prompt caching)
```

**Golden rule:** edit knowledge in **Outline**, edit prompts in **Langfuse** — neither needs a deploy.

### Model lineup
| Tier | Model |
|---|---|
| Router | `google/gemini-3.1-flash-lite` |
| HR / Product | `anthropic/claude-sonnet-4-6` |
| General | `google/gemini-3.1-flash-lite` |
| Async / Eval | `deepseek/deepseek-v4-flash` |

## Repo layout

```
bob-sidekick/
├── api/                     # Vercel entrypoints (chat.ts, teams.ts)
├── src/
│   ├── channels/            # teams, conversation refs, history, rate limit
│   ├── pipeline/            # precache, router, domainBot, normalize
│   ├── kb/                  # outline, cache, local, select (per-question retrieval), holidays
│   ├── prompts/             # langfusePrompts (pull from Langfuse + fallback)
│   ├── llm/                 # openrouter (cache_control)
│   ├── obs/                 # langfuse (trace/score), alert
│   └── store/               # redis (Upstash)
├── prompts/fallback/        # offline-safety copies of Langfuse prompts
├── knowledge-base/wiki/     # local KB fallback (hr/, process/)
├── test-cases/              # eval + smoke JSONL
├── scripts/                 # refresh-kb, run-eval, analyze-*, send-proactive, ...
├── docs/                    # status.md (live), migration-plan-v2.md (rationale)
└── _archive/                # deprecated n8n/Notion-era artifacts
```

## Local dev

### Prerequisites
- Node.js 20+
- `.env` with: `OPENROUTER_API_KEY`, `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_HOST`,
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, `OUTLINE_API_TOKEN`/`OUTLINE_BASE_URL`/`OUTLINE_COLLECTION_IDS`,
  `AZURE_BOT_ID`/`AZURE_BOT_SECRET`/`AZURE_TENANT_ID`, `KB_ADMIN_EMAILS` (see `.env.example`)

### Common commands
```bash
npm run check                 # connectivity check for all services
npm run refresh-kb            # sync Outline → Redis knowledge bundles
npx tsx scripts/run-eval.mjs --baseline test-results/eval-baseline.jsonl   # regression eval
node scripts/analyze-langfuse.mjs [days]   # latency / cost / token / cache analysis
```

### Deploy
**git push → `main` only** (Vercel auto-deploys the Git-integrated project).
Do **not** use `vercel --prod` — the local CLI is linked to the wrong project (no env vars).

## Critical rules (encoded in prompts + eval)

1. **No HR/Finance hallucination** — refuse if no source
2. **No fake product pricing/promo** — volatile data = refuse + route Sales
3. **No bypass approval** — sensitive/finance = route owner
4. **Resist prompt injection** — yield to system prompt, never reveal internals
5. **Cite every fact** — answers carry Outline source URLs
6. **Trace everything** — every turn = a Langfuse trace (cost/model/user/score)

## Owner

Jor / Pongsawat K. — Head of Contech BU, PM
</content>
