# Phase 0 — Setup Checklist (Jor)

> เป้าหมาย: เตรียม account/key ของทุก service แล้วรันสคริปต์ตรวจสอบให้ผ่าน
> เวลาโดยรวม: ~30–45 นาที (ส่วนใหญ่คือสมัคร account)

โค้ด scaffold + สคริปต์ตรวจสอบ ผม (AI) เขียนให้แล้ว — **ส่วนที่คุณต้องทำคือสมัคร account แล้วเอา key มาใส่ `.env`** เพราะผมสร้าง account แทนไม่ได้

---

## ขั้นที่ 1 — สร้าง `.env`

```bash
cp .env.example .env
```
แล้วเปิด `.env` เติมค่าตามด้านล่าง (ไฟล์ `.env` ถูก gitignore ไว้แล้ว — ปลอดภัย ไม่ขึ้น git)

---

## ขั้นที่ 2 — สมัคร + เอา key มาใส่

### 2.1 OpenRouter (LLM) — *จำเป็นสำหรับ D4*
1. ไป [openrouter.ai](https://openrouter.ai) → Sign in
2. **Settings → Keys → Create Key** → คัดลอกมาใส่ `OPENROUTER_API_KEY`
3. เติมเครดิตขั้นต่ำ (เช่น $5) เพื่อทดสอบ
4. **Billing → ตั้ง limit** กันค่าใช้จ่ายหลุด (เช่น $20/เดือนช่วง dev)
5. เปิด [openrouter.ai/models](https://openrouter.ai/models) → หา Claude Sonnet 4.6 → คัดลอก **slug** มาใส่ `OPENROUTER_MODEL` (ถ้าต่างจากค่า default)

### 2.2 Langfuse (prompt + monitoring) — Cloud free
1. ไป [cloud.langfuse.com](https://cloud.langfuse.com) → Sign up (เลือก region EU/US ตามสะดวก)
2. **New Project** → ชื่อ `bob-sidekick`
3. **Settings → API Keys → Create** → ได้ Public key + Secret key
4. ใส่ `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`
5. `LANGFUSE_HOST` = `https://cloud.langfuse.com` (US) หรือ `https://us.cloud.langfuse.com` / `https://cloud.langfuse.com` ตาม region ที่สมัคร — เช็คที่ Settings

### 2.3 Upstash Redis (bundle cache)
1. ไป [console.upstash.com](https://console.upstash.com) → Sign up
2. **Create Database** → Type: Redis → เลือก region ใกล้ Vercel deployment
3. ในหน้า database → **REST API** → คัดลอก `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

### 2.4 Outline (knowledge) — *เตรียมไว้ใช้ Phase 2*
1. ไป [outline.builk.id](https://outline.builk.id) → Login
2. **Settings → API Tokens → New Token** → ชื่อ `bob-sidekick` → คัดลอกใส่ `OUTLINE_API_TOKEN`
3. `OUTLINE_BASE_URL` = `https://outline.builk.id`
4. (`OUTLINE_COLLECTION_IDS` เว้นว่างไว้ก่อน — เติมตอน Phase 2)

> Azure Bot (Teams) ยังไม่ต้องทำตอนนี้ — ทำตอน Phase 1 ปลายๆ ตาม **Teams + Azure Bot Setup Guide** ใน Notion

---

## ขั้นที่ 3 — รันสคริปต์ตรวจสอบ

> ต้องมี **Node.js 20+** (เช็ค: `node -v`) — สคริปต์ใช้แค่ `fetch` ไม่ต้อง `npm install`

### 3.1 Connectivity check (ทุก service)
```bash
npm run check
```
ควรเห็น ✅ ครบทุกตัวที่ตั้ง key แล้ว (ตัวที่ยังไม่ตั้งจะขึ้น ⏭️ SKIP — ไม่เป็นไร)

### 3.2 cache_control verification (Decision D4 — สำคัญสุด)
```bash
npm run verify:cache
```
- ✅ **PASS** = prompt caching ทำงาน → cost Product Bot ลดตามแผน → ปิด D4 ได้
- ⚠️ **UNCONFIRMED** = ส่ง usage ที่ print มาให้ Claude ดู (อาจแค่ field ชื่ออื่น หรือ model slug ต้องปรับ)

---

## เสร็จ Phase 0 เมื่อ

- [ ] `.env` มี key ครบ (OpenRouter, Langfuse, Upstash, Outline)
- [ ] `npm run check` → ✅ OpenRouter / Langfuse / Upstash / Outline
- [ ] `npm run verify:cache` → ✅ PASS (D4 ปิด)
- [ ] git repo มี baseline + scaffold commit แล้ว (AI ทำให้)

ครบแล้ว → เริ่ม **Phase 1** (สร้าง service + Teams adapter) ได้เลย
