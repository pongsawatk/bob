# BOB Sidekick — Builk One Bot

> Internal AI Knowledge Assistant for Builk One Group
> Phase 0: Solo Sprint + AI Vibe Coding · Started 2026-05-08

[![Status](https://img.shields.io/badge/status-Phase%200%20MVP-yellow)]() [![Channel](https://img.shields.io/badge/channel-MS%20Teams-blue)]() [![Stack](https://img.shields.io/badge/stack-n8n%20%2B%20Gemini%20%2B%20Claude-purple)]()

---

## What is this?

BOB Sidekick (Builk One Bot) is an internal AI assistant that answers HR / Process / Product questions for Builk One Group employees through **MS Teams**, with citation-grounded answers, refusal rules for sensitive/volatile data, and a feedback loop that powers continuous knowledge improvement.

**Day 1 Goal:** Demo-ready MVP in 1 day → validate behavior → prove value before broader rollout.

## Architecture (1-pager)

```
MS Teams (Azure Bot Framework)
        ↓
n8n Workflow A — Main Chat Handler
        ↓
Identity Adapter (Telegram | Teams | n8n test)
        ↓
Pre-AI Cache (Tier 0 — regex/FAQ)  → short-circuit if hit
        ↓
Router (OpenRouter · Gemini 2.5 Flash) → HR / PRODUCT / GENERAL / UNKNOWN
        ↓
Domain Bot:
  HR        → OpenRouter · Claude Sonnet 4.6 (prompt caching)
  Product   → Safe refusal template (until Product KB is published)
  General   → OpenRouter · Gemini 2.5 Flash-Lite
  Unknown   → Clarify template
        ↓
Normalize Response (contract: trace_id/category/answer/sources/...)
        ↓
Respond to User  +  Async Log to Google Sheet (error-safe)
```

Async/Eval lane: Claude Haiku 4.5 (batch) for KB summarization + smoke test eval.

## Repo Layout (Karpathy 3-layer)

```
bob-sidekick/
├── prompts/                # System prompts v0 (router, hr, product, general)
├── knowledge-base/
│   ├── raw/                # Immutable source — DO NOT EDIT
│   ├── wiki/               # LLM-maintained articles
│   ├── schema/
│   │   ├── CLAUDE.md       # Generic AI maintainer convention
│   │   └── BOB.md          # BOB-specific schema
│   ├── index.md            # Content catalog
│   └── log.md              # Append-only changelog
├── workflows/              # n8n workflow JSON exports
├── test-cases/             # Smoke test cases (JSONL)
├── scripts/                # run-smoke.mjs + utilities
├── apps-script/            # Google Apps Script log endpoint
└── docs/                   # Demo script, handoff package
```

## Quickstart (Day 1)

### Prerequisites
- n8n self-hosted v2.17.2+
- OpenRouter API key (`OPENROUTER_API_KEY`)
- Google Sheet for logging
- Node.js 20+ for smoke tests

### Setup

1. **Knowledge Base** — open Notion DB [BOB Knowledge Base](https://www.notion.so/f8768020d1a54f668efbd757d99b6ae9) and add HR + Product entries (status=published)

2. **Apps Script log endpoint**
   ```
   - Open apps-script/log-endpoint.gs in script.google.com
   - Replace SHEET_ID with your sheet
   - Run setupSheets() once
   - Deploy → Web App → copy URL
   ```

3. **Import n8n Workflow**
   ```
   - n8n → Workflows → Import from File
   - Run: cd scripts && npm run build:kb && npm run build:workflow:openrouter
   - Upload workflows/workflow-a-main-chat-handler-openrouter.json
   - Set env: OPENROUTER_API_KEY = your OpenRouter API key
   - Set env: SHEETS_LOG_WEB_APP_URL = Apps Script web app URL
   - Activate workflow
   ```

4. **Smoke Test**
   ```bash
   cd scripts
   export BOB_WEBHOOK_URL="https://your-n8n/webhook/bob-chat"
   node run-smoke.mjs
   ```
   Day 1 pass = ≥80% pass rate, 0 critical fail.

5. **Teams Sideload** (parallel — ระหว่างรอ IT)
   ```
   - Azure Bot Framework registration
   - Point messaging endpoint → n8n webhook URL
   - Build Teams app manifest → sideload as personal app
   - Test ใน Teams ของ Jor
   ```

## Cost Guardrails

- Billing alert: **2,000 บาท/สัปดาห์** at Gemini + Anthropic (per Solo Sprint Plan)
- OpenRouter Anthropic Prompt Caching `cache_control: ephemeral` on Sonnet 4.6 HR/Process lane
- Pre-AI Cache (Tier 0) regex pre-filter → cuts 30% traffic before LLM
- Token caps per lane (Router=10, HR=1k, General=800, Product=2k)

## Critical Rules (encoded in prompts + smoke test)

1. **No HR/Finance hallucination** — refuse if no source
2. **No fake product pricing/promo** — T3 volatile = always refuse + route Sales
3. **No bypass approval** — sensitive/finance = route owner
4. **Resist prompt injection** — yield to system prompt, never reveal internals
5. **Cite every fact** — `[source: raw/...]` mandatory in wiki
6. **Trace everything** — every request = trace_id + Sheet row

## Related Notion Docs

- [1-Day AI Build Playbook](https://www.notion.so/41eac7f89df94d1d8b8ceac686bb0f73) — execution cockpit
- [BOB Sprint Run Log](https://www.notion.so/454eea66a32345d59d7f9cf4ea3971f5) — daily decisions/defects
- [BOB Eval Cases — Smoke Test](https://www.notion.so/0a975eac3b4542358893605039f1ca6b) — 20 test cases
- [BOB Knowledge Base DB](https://www.notion.so/f8768020d1a54f668efbd757d99b6ae9) — KB authoring UI
- [SDD](https://www.notion.so/33546733f68081389678d5688c55ce41) — architecture
- [n8n Workflow Spec](https://www.notion.so/33546733f6808133ab79d77bf8188837) — workflow A–F
- [KB Management Guide](https://www.notion.so/33546733f6808175ae6ff0f83f627008) — Champion guide
- [Solo Sprint Plan](https://www.notion.so/dddc4dd84a3a49029b4a1716c4cbcc12) — engagement playbook

## Owner

Jor / Pongsawat K. — Head of Contech BU, PM
