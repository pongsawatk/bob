# BOB Sidekick — Project Status & Roadmap

> **Single source of truth** ว่าโปรเจกต์ทำอะไรไปแล้ว กำลังทำอะไร และจะทำอะไรต่อ
> อัปเดตล่าสุด: **2026-07-04** · เจ้าของ: Jor / Pongsawat K. (Head of Contech BU, PM)
>
> เอกสารนี้สรุปจากบันทึกการทำงานสะสม. รายละเอียดเชิงลึก/บทเรียนเฉพาะเรื่องอยู่ใน
> Notion (ลิงก์ท้ายไฟล์) และ commit history. เหตุผลเชิงสถาปัตยกรรมดู
> [`migration-plan-v2.md`](./migration-plan-v2.md).

---

## 1. BOB คืออะไร (สถานะปัจจุบัน)

BOB (**Builk One Buddy**) = ผู้ช่วย AI ภายในของ Builk One Group ตอบคำถาม **HR / Process / Product**
ใน **MS Teams** คำตอบอ้างอิงแหล่งที่มา (citation) มีกฎปฏิเสธข้อมูลอ่อนไหว/ผันผวน และมี
feedback loop ปรับปรุงความรู้ต่อเนื่อง.

**สถานะ:** 🟢 **Live org-wide** — rollout สำเร็จ 2026-06-06 (138 คน installed, 0 error).
ใช้งานจริงต่อเนื่อง (~13–24 เทิร์น/วัน, 61 คนใน 7 วันล่าสุด).

**BOB = reference template ตัวแรกของ fleet** — bot ตัวถัดไป = clone repo + Langfuse project ใหม่
+ Azure Bot F0 ใหม่ (subscription เดียวกัน).

---

## 2. สถาปัตยกรรมปัจจุบัน (ของจริง)

```
MS Teams ⇄ Azure Bot F0 ($0, Single-Tenant) ⇄ Vercel /api/teams
                                                     │
                              ┌──────────────────────┼───────────────────────┐
                              │  BOB Service (TypeScript / Node 20, src/)      │
                              │  channel → rate-limit → pipeline:              │
                              │    precache → router → domainBot → normalize   │
                              └───┬──────────────┬─────────────┬──────────────┘
                          prompt │      knowledge│       trace │ score
                                 ▼              ▼             ▼
                          ┌──────────┐   ┌───────────┐  ┌──────────────┐
                          │ Langfuse │   │  Outline  │  │   Langfuse   │
                          │ Prompts  │   │ → Redis   │  │ Observability│
                          │(+fallback│   │ (Upstash) │  │(trace/cost/  │
                          │  files)  │   │           │  │  score)      │
                          └──────────┘   └───────────┘  └──────────────┘
                                 │
                          OpenRouter (Gemini + Claude, 1 key, prompt caching)
```

**กฎทอง:** แก้ความรู้ = แก้ใน **Outline** · แก้ prompt = แก้ใน **Langfuse** · ทั้งสองไม่ต้อง deploy โค้ด.

### Pipeline (src/pipeline/)
1. **precache** — Tier-0 short-circuit (greeting ฯลฯ) ก่อนเข้า LLM
2. **router** — จัดหมวด HR / PRODUCT / GENERAL / UNKNOWN
3. **domainBot** — เรียก LLM ตามหมวด (HR ใช้ per-question retrieval)
4. **normalize** — ประกอบ response + citation + Adaptive Card (ปุ่ม 👍/👎)

---

## 3. Stack & Decisions (locked 2026-06-01)

| Layer | เครื่องมือ | เจ้าของ / หมายเหตุ |
|---|---|---|
| Channel | **MS Teams** (ตัด Telegram ออกตั้งแต่ Phase 1) | Azure Bot F0 = Teams channel ฟรี $0 |
| Compute | **Vercel** (git push = auto-deploy) | maxDuration 60s/function |
| Knowledge | **Outline → Upstash Redis** | request path ไม่แตะ Outline (refresh เป็น manual) |
| Prompts | **Langfuse Prompt Management** + fallback files | non-dev แก้เองได้ มีผลใน ~60s |
| Observability | **Langfuse Cloud** (Hobby free, ~50K units/mo) | อัป Core $29/mo เมื่อชน 50K |
| LLM gateway | **OpenRouter** (1 key, prompt caching) | usage.include=true ดึง cost จริง |
| Conv. memory | **Upstash Redis** (key `bob:conv:{id}`, TTL 24h) | รอด cold start, `/clear` ล้างเอง |

**n8n** = เก็บไว้ทำ automation ที่ไม่ใช่ AI core เท่านั้น (ไม่เอา pipeline ไปวาดใน n8n).

### Model lineup (อัปเดต 2026-07-05 — HR/Product → Sonnet 5)
| Tier | Model |
|---|---|
| Router | `google/gemini-3.1-flash-lite` |
| HR | `anthropic/claude-sonnet-5` (env `MODEL_HR`; default โค้ด = 4-6) |
| Product | `anthropic/claude-sonnet-5` (env `MODEL_PRODUCT`) |
| General | `google/gemini-3.1-flash-lite` |
| Async / Eval (judge) | `deepseek/deepseek-v4-flash` |

> Sonnet 5 ใหม่กว่า+ถูกกว่า ~40%/call (eval 31/32 ผ่าน). สลับผ่าน env, rollback = ลบ env.
> `maxTokens` HR = 1300 (จาก 1000) แก้คำตอบตัดกลางประโยค.

---

## 4. Infra / Endpoints / IDs

- **Repo:** https://github.com/pongsawatk/bob (private, `main`)
- **Prod:** https://bob-sidekick.vercel.app · Teams endpoint `POST /api/teams` · test `POST /api/chat`
- **Vercel prod project:** `prj_EgzugREDS2VIwnPxjMYtEv4Uo0Jb` (Git-integrated, มี env)
  ⚠️ **deploy ผ่าน git push เท่านั้น** — CLI ในเครื่อง link ผิด project (`prj_ddv…` ไม่มี env)
- **Azure Bot / App ID:** `06f1e303-e8d2-4bd2-8b8a-d4fff49d7c18` · Tenant `dbb514a1-e97b-4b50-be5f-c00508b9ad5a`
- **Subscription:** `Bot-Platform` (MCA ของ Kittisak), RG `rg-bob`
- **Outline collection "BOB Knowledge Base":** `dab98231-5cc8-4805-9dcd-7e447a292398` (ฝั่ง Product)
- **Outline collection "HR Shared":** `47de7bb9-7fe8-4d48-98eb-4e577e94e442` (ฝั่ง HR/Process — HR ดูแลเอง;
  5 หมวด: Benefits / Announcement / HR / Policy / Process) → ตั้ง env `OUTLINE_HR_COLLECTION_IDS`
- **`/api/chat` (test endpoint):** ต้องส่ง header `x-test-key` = env `CHAT_TEST_KEY` (ไม่ตั้ง env = ปิด)
- **Langfuse project:** `bob-sidekick` (cloud.langfuse.com)
- **KB admin (`/refresh`):** pongsawat@builk.com, bhoomchai@builk.com

---

## 5. ✅ ทำเสร็จแล้ว

### Phase 0–1 — Infra + Teams ตอบได้
- git/scaffold/keys, Vercel auto-deploy, Azure Bot Single-Tenant
- **Teams 401 แก้จบ** (2026-06-02) — ต้องสร้าง Azure Bot resource จริง + ใส่ `channelAuthTenant`
- typing indicator ระหว่างรอ LLM, conversation history (Redis, 24h, `/clear`)

### Phase 2 — Knowledge (Outline → Redis)
- read path: in-memory (TTL 60s) → Redis → ไฟล์ local fallback
- HR 23 + Process 13 + Product 8 blocks seeded ใน prod Upstash
- `/refresh` ใน Teams (admin เท่านั้น) + `npm run refresh-kb`
- citation: ฝัง Outline URL ในแต่ละ block

### Phase 3 — Observability + Feedback
- Langfuse tracing ครบ: input/output, cost จริง (OpenRouter), model, user=email,
  prompt version, sessions, tags, router-as-generation, cache ROI, feedback 👍/👎 score
- prompts migrate เข้า Langfuse (label `production`) + fallback files sync กัน

### Phase 4 — Hardening
- `fetchRetry` (per-attempt timeout + budget-aware retry, ไม่ retry ตอน timeout)
- rate limit (Redis 20 msg/คน/นาที, fail-open)
- error alert → Teams webhook (`ALERT_WEBHOOK_URL`)

### Proactive greeting + Org-wide rollout (2026-06-04 → 06)
- Graph proactive install ยิง `installationUpdate` + `conversationUpdate` → BOB ทักเอง
  (dedupe ด้วย `conversation.id`)
- `scripts/send-proactive.mjs` (`--provision --emails-file`) →
  **138 installed + 23 already · 0 fail** จาก curated list

### Performance & Cost (2026-06-07 → 08)
- **per-question HR retrieval** (`src/kb/select.ts`) — ตัด context ~58%, domain LLM latency ~55%
  (เคสเจาะจง 38.7K→16.2K tok); broad/no-signal → full bundle (catch-all)
- prompt cache TTL 5m → **1h** (ลด cost; ไม่ช่วย latency เพราะยัง attend เท่าเดิม)
- precompute วันหยุดที่เหลือ (`src/kb/holidays.ts`) inject เข้า HR prompt
- latency profiling (แก้ measurement bug: จับเวลาหลัง `res.json()`)

### Refactor + HR Shared migration (2026-07-04)
- **KB ฝั่ง HR ย้าย source ไป Outline "HR Shared"** (`src/kb/outline.ts` + env `OUTLINE_HR_COLLECTION_IDS`)
  — ทุก doc ใน collection → HR side (หมวด "Process — …" → process bundle), title line ติดป้ายหมวด
  `## [Benefits — สวัสดิการ] …` ช่วย retrieval + citation. เมื่อ set env นี้ hr/process ใน BOB KB เดิม
  จะถูกข้าม (กัน duplicate stale). ทดสอบจริง: HR 23 + Process 12 blocks (~49.5K chars).
- **PII guard:** เอกสาร "Employee Directory / ทะเบียนพนักงาน" ใน collection ถูก exclude จาก bundle เสมอ
- **แก้บั๊ก SEP collision** — doc ที่มีเส้น `---` ในเนื้อหาเคยถูก split เป็น block ปลอมไร้ header/citation
  (กระทบ prod อยู่: Product 15→9 blocks) → แปลง `---` เป็น `***` ตอน assemble
- **precache วันหยุดคงเหลือ** (`precache.ts`) — "วันหยุดเหลือกี่วัน" ตอบ deterministic จาก `holidays.ts`
  ไม่เรียก LLM (คำถามแนะนำ #1 ~27% traffic); guard เข้ม: วันลา/รายเดือน/เทศกาล → LLM ตามเดิม
  + greeting/thanks จับคำลงท้าย (สวัสดีครับ/ขอบคุณค่ะ)
- **ปิดช่องโหว่ `/api/chat`** — เดิมเปิด public ไม่มี auth (ใครก็เผา OpenRouter credit ได้)
  → ต้องส่ง `x-test-key` ตรงกับ env `CHAT_TEST_KEY`; ไม่ตั้ง env = 401 ทุกกรณี
- **แก้บั๊ก emailCache** จำค่าว่างถาวรเมื่อ `getMember` ล้มชั่วคราว (ทำ admin check + Langfuse user เพี้ยน)
  + `/refresh` ใช้ `resolveEmail` ร่วมกัน (ตัดโค้ดซ้ำ)
- **guard คำตอบว่างจาก OpenRouter** — เดิมการ์ดเปล่าหลุดถึง user เงียบ ๆ → โยน error ให้ onTurnError + alert
- **router fallback รู้จัก Kwanjai/ขวัญใจ** ใน PRODUCT (⚠️ ต้อง sync Langfuse router prompt ด้วย)
- `.gitignore` เพิ่ม `scripts/tmp-*` (ไฟล์วิเคราะห์ชั่วคราว)

### Quality / Eval
- **eval regression guard** — `test-cases/bob-eval-hr.jsonl` (31 เคสจากคำถามจริง)
  + `scripts/run-eval.mjs` (rule-based + deepseek judge, โหมด `--baseline`)
- baseline ปัจจุบัน: **30 PASS / 1 WARN / 0 FAIL** (`test-results/eval-baseline.jsonl`)
- ยืนยันบน production: วันหยุดนับถูก 100%, injection บล็อก 9/9, HumanSoft redirect ตรง

---

## 6. 🔄 กำลังทำ / เฝ้าดู

- **Repo audit 2026-06-27:** `npm run typecheck` และ `npm run build` ผ่าน. `main` ยัง ahead `origin/main` 2 commits
  และมีไฟล์วิเคราะห์ Langfuse/Q&A แบบ untracked ใน `scripts/tmp-*`, `scripts/tmp-qa-data.json`,
  `scripts/tmp-qa-review.txt`, `scripts/analyze-qa.mjs` (ยังไม่ stage/commit).
- **Markdown audit 2026-06-27:** ค้นแบบ `-Force` แล้วไม่พบ `.md` ซ่อนนอกชุดที่อ่านแล้ว. `.claude/` มีแค่
  `settings.local.json`; `_archive/docs/*` และ `_archive/kb-schema/*` เป็นเอกสาร Claude/AI pairing ยุคเก่า
  (n8n + Notion KB + Sheets) ให้อ่านเป็นประวัติ/บทเรียน ไม่ใช่ runbook ปัจจุบัน.
- **เก็บ latency breakdown production** (timings/spans ใน trace) ต่ออีก 1–2 วันเพื่อยืนยันผล
- **Langfuse scoring** — เหลือตั้ง Score Config + Human Annotation (ช่วงเบต้า) ก่อนทำ LLM-as-judge
- ตอบ feedback 👍/👎 ภายใน 24 ชม. (commitment ช่วง beta)

---

## 7. 📋 แผนถัดไป (เรียงตาม impact)

### Latency / Cost — คอขวดย้ายไป output tokens แล้ว
จากการวัดรอบ 2 (169 เทิร์น): retrieval ลด input จริง แต่ p50 ลดแค่ 13.3s→12.5s
เพราะ **คอขวดตอนนี้ = ความยาวคำตอบ** (p50 427 tok, broad 1,000 tok ชนเพดาน).
- ~~[Quick win] precache คำถามแนะนำ~~ → **ทำแล้ว 2026-07-04** สำหรับ "วันหยุดเหลือกี่วัน"
  (ข้อเดียวที่ deterministic ได้). "ลาอะไรได้บ้าง"/"เบิกทันตกรรม" ต้องการ KB nuance — ยังไป LLM.
- **คุมความยาวคำตอบ** (คำตอบโดนตัดกลางประโยค 15 เทิร์น/สัปดาห์: HR ชน 1000 ×13, Product ชน 2000 ×2)
- ทดลอง **Haiku 4.5** กับ HR retrieved mode (ต้องผ่าน eval 31 เคสก่อน)
- cron warm-ping ลด cold start (43% ของ HR turns, overhead ~0.8s)

### Quality — bug พบจากการใช้จริง (รอบ 2, 5–11 มิ.ย.)
- **router ไม่รู้จัก Kwanjai/ขวัญใจ** ใน PRODUCT → misroute ไป HR ตอบ "ไม่มีข้อมูล" ทั้งที่ KB มี
- **GENERAL/Gemini แต่งข้อมูลตัว BOB** (เช่น อ้างช่วย IT, รับปากเรียนรู้จากผู้ใช้) → เพิ่ม BOB fact sheet
  ใน general prompt. หมายเหตุ: ชื่อ "Builk One Buddy" = **ชื่อทางการแล้ว** (ใส่ใน prompt/welcome ตั้งแต่ 2026-06-12)
- **Kwanjai fix 2026-07-04:** `router.txt` (fallback) ใส่ `Kwanjai/ขวัญใจ` ใน PRODUCT แล้ว —
  **เหลือ sync Langfuse router prompt** (New version + label `production`) ให้ตรงกัน.
- date arithmetic นอก precompute ยังพลาด (บอกวันในสัปดาห์ผิด)
- UNKNOWN ใช้ข้อความก้อนเดียวทั้ง injection + คำถามสุจริต → ดูไม่เป็นมิตร
- Teams `<quoted messageId>` ยังไม่ถูก resolve
- **เพิ่ม 9 injection patterns** (จาก user ที่ตั้งใจทดสอบ) เข้า eval set

### Feature broadcast — 🚀 ARMED 2026-07-07 → ส่งจริงพุธ 2026-07-08 08:00 ICT
ประกาศฟีเจอร์ให้พนักงานทุกคน ทักชื่อเล่นรายคน (การประกาศ = สาธิตฟีเจอร์ "รู้จักคุณ"):
- `src/channels/broadcast.ts` + `api/broadcast.ts` (cron endpoint) + `scripts/broadcast.ts` (CLI)
- Vercel cron ทุกวัน 01:00 UTC = **08:00 ICT** (เปลี่ยนจาก 10:00 ตามแผนส่ง 8 ก.ค.)
- idempotent รายคน (SETNX), ตัดคนลาออก/service/ระบุตัวไม่ได้, 2 variant (matched/fallback)
- self-intro flag `bob:introduced:{email}` — คนที่ HR เพิ่มเข้าทะเบียนทีหลังได้ยิน "รู้จักคุณแล้ว" ครั้งแรก
- **7 ก.ค.:** HR confirm ชื่อเล่นแล้ว · refresh directory (132 active + 142 resigned — ตัวเลข 273 เดิม
  คือก่อน fix แยกคนลาออก) · rebuild roster = **144 คน (131 personalized + 13 fallback), ตัด 20** ·
  self-test ส่งจริงหา pongsawat ทั้ง 2 variant ✅ · arm env `CRON_SECRET`+`BROADCAST_CAMPAIGN=launch-2026-07`
  บน Vercel project **"bob"** (relink CLI จาก "bob-sidekick" ตัวหลอกแล้ว)
- **baseline ก่อนส่ง (14 วัน, ตัด eval):** ผู้ใช้จริง ~13 คน / ~40 ข้อความ, 50% ใช้ครั้งเดียวแล้วหาย
- **หลังส่ง (8 ก.ค.):** ตรวจผล cron (sent/failed) → **clear `BROADCAST_CAMPAIGN` ทันที** → analyzer week-2 retention
- ดู memory [[project-broadcast]]

### Employee personalization — ✅ shipped 2026-07-05
BOB รู้จักพนักงานจาก email แล้ว (ทัก "คุณจ้อ", รู้ตำแหน่ง/ทีม/อายุงาน/หัวหน้า):
- `src/people/directory.ts` — Graph workbook API อ่าน "BOG ทะเบียนพนักงาน For All.xlsx"
  (SharePoint, HR ดูแล) → parse 273 คน → Redis `bob:directory` + mem TTL 60s.
  **refresh path เท่านั้นที่แตะ Graph** (มากับ `/refresh`, non-fatal ต่อ KB refresh)
- Graph auth = App Registration เดิมของบอท (`Sites.Read.All` Application + admin consent ✅ 2026-07-05)
- **2-block system content** (`openrouter.ts userContext`): KB block cache ตามเดิม,
  profile block เล็ก (~100 tok) ไม่ cache — แคชแชร์ข้ามผู้ใช้ไม่แตก
- ฉีด profile ทั้ง HR / PRODUCT / GENERAL (GENERAL ด้วย เพราะ "คุณรู้จักผมไหม" route ไปที่นั่น)
- PII: block มีกฎห้ามเปิดเผยข้อมูลคนอื่น + eval case `PII-other-person` + directory doc
  ใน Outline ถูกกันออกจาก KB bundle (`EXCLUDE_TITLES`)
- date quirk: วันเริ่มงานมาเป็น Excel serial (ไม่ใช่ text) + ปี พ.ศ. → แปลงสองชั้นใน `parseThaiDate`
- ค้าง: HR เพิ่มคอลัมน์ **สถานะการจ้าง/ผลิตภัณฑ์ที่ดูแล** (โค้ด map รอไว้แล้ว: `iEmpType`);
  **pain #1 "วันลาคงเหลือ"** ยังต้อง HumanSoft API (เฟสถัดไป); ควรอัปเดต Langfuse hr prompt
  rule 6 (อายุงานตอนนี้ตอบจาก profile ได้ ไม่ต้อง redirect HumanSoft แล้ว)

### Phase 4 — Decommission ของเก่า (นอก repo)
ปิด n8n Workflow A, Apps Script/Sheets logging, Notion KB DB เมื่อมั่นใจ BOB แทนครบ.

---

## 8. KB content gaps — ต้องได้ข้อเท็จจริงจาก HR/Jor ก่อน

> เติม wiki จริงไม่ได้ถ้าไม่มีต้นทาง (ห้ามแต่งข้อมูล HR)

1. **ลาพักร้อน/พักผ่อนประจำปี** — KB มีลา 8 ประเภทแต่ขาดตัวนี้; ต้นฉบับอยู่ raw `ข้อบังคับฯ.txt`
   หมวด 4 ที่ไม่อยู่ใน repo
2. **Pojjaman ERP** — ไม่อยู่ใน collection ของบอท (อยู่ PJM-*/Implement collections)
3. **ประกันกลุ่ม (group insurance)** — user คาดว่ามีแต่ KB ไม่มี → ถาม HR ว่ามีจริงไหม
4. ข้อบังคับบริษัทเนื้อหารายหมวด (ตอนนี้มีแค่ชื่อหมวด)
5. backlog จากคำถามจริง: เปิด Grab บริษัท, ผลตอบแทนกองทุน (Eastspring), Bugday, Brand identity,
   นามสกุลใน employee directory

---

## 9. Maintenance Runbook

### แก้ prompt (non-dev, ไม่ต้อง deploy)
Langfuse → Prompts → เลือก prompt → New version → แก้ → save + ติด label `production` → มีผล ~60s.
rollback = ย้าย label `production` กลับ version เก่า.
**ห้ามลบ placeholder** `{{KB_BUNDLE}}` `{{CURRENT_DATE}}` `{{user_name}}` `{{department}}`
(โค้ด `.replace()` ตรงตัว ถ้าหายจะไม่ inject). ต้อง sync `prompts/fallback/*.txt` ด้วย.

### แก้ความรู้
แก้ใน Outline → พิมพ์ `/refresh` ใน Teams (admin) หรือ `npm run refresh-kb`.
- **ฝั่ง HR/Process:** แก้ใน collection **"HR Shared"** (HR ดูแลเอง; หมวดบนสุดเป็นตัวกำหนด:
  "Process — …" → process, ที่เหลือ → hr). เอกสารชื่อ "Employee Directory/ทะเบียนพนักงาน"
  จะถูกกันออกจาก bundle อัตโนมัติ (PII guard).
- **ฝั่ง Product:** แก้ใน "BOB Knowledge Base" เหมือนเดิม (top-level `Product — …`).
- **เปิดใช้ HR Shared:** ตั้ง env `OUTLINE_HR_COLLECTION_IDS=47de7bb9-7fe8-4d48-98eb-4e577e94e442`
  (Vercel + `.env`) → ตรวจว่า OUTLINE_API_TOKEN อ่าน collection นี้ได้ → รัน eval → `/refresh`.
  ไม่ตั้ง env = พฤติกรรมเดิม 100%.

### Deploy
**git push → main เท่านั้น** (auto-deploy Vercel). อย่าใช้ `vercel --prod` (link ผิด project).
ดู logs/deployments ใน Vercel dashboard ของ `prj_Egz…`.

### Eval ก่อน ship (โดยเฉพาะแตะ HR bundle/retrieval)
```bash
npx tsx scripts/run-eval.mjs --baseline test-results/eval-baseline.jsonl
```
ไม่ regress ค่อย ship (judge ต้อง maxTokens ≥800).

### วิเคราะห์ usage / perf / cost
```bash
node scripts/analyze-langfuse.mjs [days] [--raw]   # latency p50/p95, cost, token, cache hit
node scripts/analyze-usage.mjs                      # usage ราย user/วัน/หมวด
```
⚠️ Langfuse public API ติด 429 ง่าย — ต้องมี backoff + checkpoint, อย่ารัน 2 script พร้อมกัน.
field: `latency` เป็น **วินาที** (×1000), cost = `calculatedTotalCost`.

### Tunables
`src/kb/select.ts`: `BUDGET_CHARS` 18000, `MIN_DOCS` 6 (ลด budget = ประหยัดถ้า eval ยังผ่าน).
`holidays.ts`: ตารางวันหยุด ⚠️ อัปเดตรายปี.

---

## 10. Known gotchas (pointers)

รายละเอียดเต็มอยู่ใน auto-memory + Notion:
- **Vercel:** `includeFiles` ต้องระบุ static files, ใช้ `process.cwd()`, system prompt ต้องอยู่ใน
  messages array (ไม่ใช่ field แยก), CLI link ผิด project
- **Langfuse serverless:** ESM import (ห้าม `require`), อย่าตั้ง `flushAt:1`, ใช้ `generation()` ไม่ใช่
  `span()` สำหรับ cost/model, user=email ผ่าน `getMember`
- **Router/Gemini:** ต้องใส่ JSON reminder ใน user message (ไม่งั้นตอบ prose)
- **Teams proactive:** dedupe ด้วย `conversation.id`; admin-preinstall = uninstall ผ่าน Graph ไม่ได้
- **Prompt caching:** OpenRouter รองรับ Anthropic caching จริง — ส่ง system เป็น content-block array
  + `cache_control:{type:"ephemeral", ttl:"1h"}`
- **Legacy Claude docs:** `_archive/kb-schema/CLAUDE.md` / `BOB.md` ยังมีหลักการที่ควรรักษา
  (ห้ามเดา, claim ต้องมี source, T3/T4 เช่น price/promo/status ต้อง route ไป owner/API, audit trail)
  แต่ workflow เก่าเรื่อง Notion DB → wiki → n8n/Sheets ถูกแทนด้วย Outline → Redis + Langfuse แล้ว.

---

## 11. Related docs & Notion

- [`migration-plan-v2.md`](./migration-plan-v2.md) — เหตุผลเชิงสถาปัตยกรรม (ทำไมเลิก n8n)
- `_archive/docs/` — เอกสารยุค Phase-0 (n8n/Notion/Sheets) เก็บไว้อ้างอิงประวัติ; อย่าใช้เป็น checklist ปัจจุบัน
- `_archive/kb-schema/CLAUDE.md` และ `BOB.md` — convention เก่าของ AI maintainer; ใช้เฉพาะหลักการ citation/refusal/volatility
- Notion "BOB Usage, Performance & Cost — Langfuse" (`37846733f6808190ba87c00896059653`)
- Notion "วิเคราะห์การใช้งานจริง 5–11 มิ.ย. 2026" (`37c46733f68081e1973ad157a3c782d9`)
- Notion "BOB Sprint Run Log" (`454eea66a32345d59d7f9cf4ea3971f5`)
</content>
</invoke>
