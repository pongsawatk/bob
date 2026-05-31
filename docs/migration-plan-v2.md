# BOB Sidekick — Migration Plan v2 (Outline + Langfuse + Vibe-coded Service)

> เขียน: 2026-05-31 · โดย: Software Engineer (AI pairing) ร่วมกับ Jor
> สถานะ: Proposal — แทน stack เดิม (n8n-compiled prompts + Notion KB + Karpathy 3-layer + Sheets log)
> เป้าหมายหลักของเจ้าของ: **non-dev แก้ prompt เองได้ + monitor ผลเพื่อปรับ prompt** และ **AI develop ทั้งหมด**

---

## 1. หลักการออกแบบใหม่ (เปลี่ยนจาก SDD เดิม)

แยก "สิ่งที่เปลี่ยนบ่อย" ออกจาก "โค้ดที่เปลี่ยนยาก" ตามเจ้าของ:

| Layer | เปลี่ยนบ่อยแค่ไหน | เจ้าของ | อยู่ที่ไหน |
|---|---|---|---|
| ความรู้ (Knowledge) | บ่อย | Champions / Jor | **Outline** (markdown + version + API) |
| Prompt | บ่อย | Jor (non-dev) | **Langfuse Prompt Management** (UI + version) |
| Orchestration code | นานๆ ครั้ง | AI / Claude Code | **vibe-coded TypeScript service** (git) |
| Monitoring / Eval | ดูตลอด | Jor | **Langfuse Observability** (trace + score + dataset) |

> กฎทอง: **แก้ความรู้ = แก้ใน Outline / แก้ prompt = แก้ใน Langfuse / ทั้งสองอย่างไม่ต้อง deploy โค้ด**

---

## 2. Target Architecture

```
MS Teams (Azure Bot Framework)  +  Telegram (validation channel)
                     │ webhook / HTTPS
        ┌────────────▼─────────────┐
        │   BOB Service (TypeScript)│   ← Claude Code ดูแล, แก้น้อย
        │   channels → pipeline      │
        │   precache → router →      │
        │   domainBot → normalize    │
        └───┬──────────┬─────────┬───┘
   prompt   │   knowledge│   trace │ score
            ▼            ▼         ▼
      ┌──────────┐ ┌─────────┐ ┌──────────────┐
      │ Langfuse │ │ Outline │ │   Langfuse   │
      │ Prompts  │ │  (KB)   │ │ Observability│
      └──────────┘ └─────────┘ └──────────────┘
                     │
              OpenRouter (Gemini + Claude, 1 key, prompt caching)
```

### Tech choices
- **ภาษา:** TypeScript / Node 20+ (เข้ากับ scripts `.mjs` เดิม, SDK ครบ)
- **Bot:** `botbuilder` (Bot Framework SDK) สำหรับ Teams + adapter แยกสำหรับ Telegram
- **LLM gateway:** คง **OpenRouter** (1 key, รวม Gemini+Claude, มี prompt caching) — ไม่ rewrite
- **Knowledge:** **Outline API** (collections → documents → markdown)
- **Prompts:** **Langfuse SDK** `getPrompt(name, {label:"production"})` + local fallback
- **Observability:** **Langfuse SDK** trace/span/score
- **Hosting:** container บน server เดียวกับ n8n (ต้องมี HTTPS public endpoint สำหรับ Bot Framework + Telegram webhook)

---

## 3. Knowledge Sync Strategy (สำคัญ — กระทบ cost + latency)

ไม่ดึง Outline สดทุก request (ช้า + ชน rate limit + cache ไม่เกาะ) → ใช้ **sync เป็น bundle**:

1. Sync job ดึง published docs จาก collections ที่กำหนด (HR, Product, Process)
2. ประกอบเป็น **bundle ต่อ domain** (เช่น `hr-bundle`, `product-bundle`) เก็บใน memory/disk
3. Bot โหลด bundle เป็น **system-prompt prefix ที่ cache ได้** (Anthropic `cache_control: ephemeral`)
4. Re-sync เมื่อ: (a) Outline webhook `documents.update` หรือ (b) cron ทุก X นาที
5. แต่ละ wiki claim อ้างอิงกลับ Outline document URL = citation ฟรี

> Map กับ Knowledge Volatility Tier เดิม: **T1/T2 → Outline bundle (in-prompt)** · **T3/T4 (pricing/stock/status) → live API ทีหลัง** (ห้ามใส่ bundle)

---

## 4. Prompt & Monitoring (โจทย์หลักของเจ้าของ)

### Prompt Management (Langfuse)
- ย้าย `prompts/*.md` (router/hr/product/general) เข้า Langfuse เป็น prompt มี version + label
- Bot: `getPrompt("router", {label:"production"})` — **fallback เป็นไฟล์ใน repo** ถ้า Langfuse ล่ม (กันบอทตาย)
- Jor แก้ใน UI → version ใหม่ → ตั้ง label `production` → มีผลทันที **ไม่ต้อง deploy**
- รองรับ A/B: label `staging` ลองก่อน แล้วค่อย promote

### Observability + Eval (Langfuse)
- 1 request = 1 trace; spans: `precache → router → kb-bundle → llm` (เก็บ cost/latency/tokens)
- Adaptive Card 👍/👎 ใน Teams → POST กลับ service → `langfuse.score(traceId)`
- สร้าง **dataset จาก trace จริง** → รัน regression eval ก่อนเปลี่ยน prompt (seed จาก `test-cases/*.jsonl` เดิม)
- `scripts/run-smoke.mjs` ใช้ต่อได้ แค่ชี้ไป service ใหม่ + push ผลเป็น Langfuse score

---

## 5. Migration Phases

### Phase 0 — Infra setup (ไม่กระทบผู้ใช้)
- [ ] **git init** repo (ตอนนี้ยังไม่อยู่ใต้ git — ทำก่อน refactor เพื่อความปลอดภัย)
- [ ] Self-host **Langfuse** (docker-compose + Postgres) บน server n8n → สร้าง project + API keys
- [ ] ขอ **Outline API token** + map ว่า collection ไหน = domain ไหน + ตรวจ ACL (กันความรู้ลับหลุดเข้า bot)
- [ ] ยืนยัน hosting + HTTPS endpoint ของ service ใหม่

### Phase 1 — สร้าง service (ขนานกับ n8n, Telegram ก่อน)
- [ ] TS project + channel adapter (**Telegram ก่อน — ไม่ต้องรอ IT**)
- [ ] Pipeline: precache → router → domainBot → normalize (parity กับ n8n Workflow A)
- [ ] ต่อ OpenRouter + Langfuse (prompts+trace) + Outline sync
- [ ] รัน smoke test เดิมให้ผ่าน ≥80%, 0 critical fail

### Phase 2 — Knowledge cutover → Outline
- [ ] ย้ายเนื้อหา KB จาก Notion DB / `knowledge-base/wiki` → Outline collections
- [ ] สร้าง KB sync + bundle builder + เปิด prompt caching
- [ ] ปลดระวาง `raw/ wiki/` (เก็บ `schema/BOB.md` เป็น authoring convention ใน Outline)

### Phase 3 — Teams + feedback + monitoring
- [ ] Azure Bot Framework registration → messaging endpoint ชี้ service ใหม่
- [ ] Teams sideload ให้ Beta Squad 5–8 คน
- [ ] Adaptive Card feedback → Langfuse score
- [ ] Dashboard ที่ Jor ดูเอง (volume, cost, 👍 rate, latency P95)

### Phase 4 — Decommission ของเก่า
- [ ] เลิก n8n Workflow A, Apps Script/Sheets logging, Notion KB DB
- [ ] คง n8n **เฉพาะถ้าจะใช้ทำ cron** (KB sync / batch eval) — ไม่งั้นปิดได้

---

## 6. Repo Layout ที่เสนอ

```
bob-sidekick/
├── src/
│   ├── index.ts              # HTTP server entry
│   ├── channels/             # teams.ts, telegram.ts
│   ├── pipeline/             # precache, router, domainBot, normalize
│   ├── kb/                   # outlineClient.ts, syncBundle.ts
│   ├── prompts/              # langfusePrompts.ts
│   ├── llm/                  # openrouter.ts (cache_control)
│   └── obs/                  # langfuse.ts (trace/score)
├── prompts/fallback/         # สำเนา prompt commit ไว้ (offline safety)
├── test-cases/               # คง JSONL
├── scripts/run-smoke.mjs     # repoint ไป service ใหม่
├── docs/
└── (deprecated) workflows/, knowledge-base/raw|wiki/, apps-script/
```

---

## 7. ตัดทิ้งได้จากแผนเดิม (ลดงานเยอะ)

| ของเดิม | แทนด้วย |
|---|---|
| Karpathy raw/wiki/schema 3-layer | Outline (versioned wiki) |
| Epistemic Drift mitigation stack | Outline revision history + citation = URL |
| Workflow C/D (Contribution + Auto-Deploy) | แก้ใน Outline ตรงๆ |
| Multi-Curator Conflict protocol | Outline permission + comment |
| build script compile prompt → JSON | Langfuse Prompt Management |
| Google Sheet logging | Langfuse trace (Sheet เป็น backup ได้) |
| Notion KB DB | Outline (Notion เหลือไว้เก็บเอกสารวางแผน) |

---

## 8. Decisions / Risks ที่ต้องเคลียร์
1. **Hosting service ใหม่** — docker บน server n8n หรือ PaaS? ต้องมี HTTPS public (Bot Framework + Telegram webhook)
2. **Outline ACL** — collection ไหนให้ bot อ่านได้บ้าง (กันเอกสารลับเข้าไปอยู่ใน bundle)
3. **OpenRouter prompt caching** — ยืนยันว่า `cache_control` ส่งผ่าน OpenRouter ไปถึง Anthropic จริง (ไม่งั้น cost Sonnet พุ่ง 3–5x)
4. **git** — repo ยังไม่อยู่ใต้ version control → ต้อง init ก่อน refactor ใหญ่
5. **Azure Bot + IT** — ยังเป็น external blocker ที่ช้าสุด → Telegram-first ยังเป็นกลยุทธ์ที่ถูกต้อง
```
