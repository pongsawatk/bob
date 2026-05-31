# Day 1 — Next Steps Checklist (สำหรับ Jor)

> ผมสร้าง scaffolding ให้แล้ว — ส่วนที่ผมทำให้ไม่ได้ (ต้องใช้ credentials หรือ environment ของคุณ) อยู่ด้านล่าง

---

## 🔥 Critical Path (Day 1 — ตามลำดับ)

### Step A — Notion KB Authoring (~30 นาที)

- [ ] เปิด Notion DB [BOB Knowledge Base](https://www.notion.so/f8768020d1a54f668efbd757d99b6ae9)
- [ ] Add HR entries (5–10 row): paste HR content ที่คุณมี
  - แต่ละ row: Topic, Category=HR, Volatility (T1=stable, T3 ห้ามใส่), Status=draft → published, Owner=Jor, Sources, Last Reviewed, Content (in page body)
- [ ] Add Product entries (5–10 row): iNsite, Pojjaman, Builk360, JUBILI overview/use case
- [ ] Mark status = "published" สำหรับที่พร้อม
- [ ] **Volatile data ห้ามใส่:** ราคา, promo, contract terms, individual stock — set Volatility=T3 → bot จะ refuse

### Step B — Hand-copy KB → wiki/*.md (~20 นาที)

หลัง paste ข้อมูลใน Notion DB เสร็จ — **ส่งให้ผม** หรือบอก row ID ผมจะ:
- Generate `wiki/hr/*.md` และ `wiki/product/*.md` ให้ ตาม BOB.md schema
- ใส่ frontmatter + citations + format ตาม CLAUDE.md
- Update `index.md` + `log.md`

### Step C — Google Sheets + Apps Script (~10 นาที)

- [ ] สร้าง Google Sheet ใหม่ ชื่อ "BOB Conversation Log"
- [ ] Copy Sheet ID จาก URL
- [ ] เปิด script.google.com → New Project → Paste content จาก [apps-script/log-endpoint.gs](../apps-script/log-endpoint.gs)
- [ ] แทน `SHEET_ID` ด้วย Sheet ID ของคุณ
- [ ] Run `setupSheets()` ครั้งแรก (Authorize → Allow)
- [ ] Deploy → New deployment → Web app → Execute as Me → Anyone within domain
- [ ] **Copy Web App URL ไว้** (จะใช้ใน n8n env)

### Step D — n8n Setup (~30 นาที)

- [ ] เปิด n8n self-hosted (v2.17.2)
- [ ] Settings → Variables → เพิ่ม:
  - `SHEETS_LOG_WEB_APP_URL` = URL จาก Step C
- [ ] Settings → Variables → เพิ่ม:
  - `OPENROUTER_API_KEY` = OpenRouter API key
- [ ] Generate import-ready OpenRouter workflow:
  ```bash
  cd scripts
  npm run build:kb
  npm run build:workflow:openrouter
  ```
- [ ] Workflows → Import from File → upload [workflows/workflow-a-main-chat-handler-openrouter.json](../workflows/workflow-a-main-chat-handler-openrouter.json)
- [ ] ตรวจ model lanes:
  - Router = `google/gemini-2.5-flash`
  - HR/Process = `anthropic/claude-sonnet-4.6` + `cache_control: ephemeral`
  - General = `google/gemini-2.5-flash-lite`
  - Product = safe refusal template จนกว่า `wiki/product/*.md` จะพร้อม
- [ ] Activate workflow → copy webhook URL

### Step E — First Test (~5 นาที)

```bash
curl -X POST {WEBHOOK_URL} \
  -H "Content-Type: application/json" \
  -d '{"user_id":"jor","user_name":"Jor","message":"ผมจะลาพักร้อนต้องทำยังไง"}'
```

ตรวจ:
- HTTP 200 + JSON response
- มี `trace_id`, `category`, `answer`, `sources`
- Row เข้า Google Sheet ที่ tab "conversations"

### Step F — Smoke Test (~10 นาที)

```bash
cd "C:\Users\jingj\OneDrive\Vibe Coding\bob-sidekick\scripts"
$env:BOB_WEBHOOK_URL = "https://your-n8n/webhook/bob-chat"
node run-smoke.mjs
```

ผลที่ควรได้: ≥80% pass, 0 critical fail
ถ้า fail → paste output มาให้ผม จะช่วย iterate prompts/KB

### Step G — Cost Guardrails (~5 นาที)

- [ ] Google Cloud Console → Gemini API → Billing alerts → set 2,000 บ./สัปดาห์
- [ ] Anthropic Console → Usage → Spend limits → set $50/week (~1,750 บ.)

---

## 🚀 Parallel Track — Teams Sideload (~1-2 ชั่วโมง — ทำคู่ขนาน)

### Step T1 — Azure Bot Framework Registration

- [ ] portal.azure.com → Create Resource → Azure Bot
- [ ] เลือก Multi-tenant
- [ ] Messaging endpoint = n8n webhook URL จาก Step D
- [ ] Channels → Microsoft Teams → enable
- [ ] Configuration → copy:
  - Microsoft App ID
  - Microsoft App Password (Client Secret)

### Step T2 — Teams App Manifest

```json
{
  "manifestVersion": "1.13",
  "id": "{{NEW-GUID}}",
  "packageName": "com.builkone.bob",
  "name": { "short": "BOB", "full": "BOB Sidekick — Builk One Bot" },
  "description": {
    "short": "AI assistant for Builk One",
    "full": "ผู้ช่วย AI สำหรับ HR และ Product ของ Builk One Group"
  },
  "developer": {
    "name": "Builk One Contech BU",
    "websiteUrl": "https://builk.com",
    "privacyUrl": "https://builk.com/privacy",
    "termsOfUseUrl": "https://builk.com/terms"
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#1565C0",
  "bots": [
    {
      "botId": "{{AZURE_BOT_APP_ID}}",
      "scopes": ["personal"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

- [ ] Save เป็น `manifest.json` + zip กับ icons → `bob-bot.zip`
- [ ] Teams → Apps → Manage your apps → Upload an app → "Upload a custom app" → bob-bot.zip

### Step T3 — Test in Teams

- [ ] BOB ปรากฏใน Teams Chat
- [ ] พิมพ์ "สวัสดี" → bot ตอบ
- [ ] ลอง 3 demo questions

> ถ้า IT ไม่อนุญาต sideload → ทำผ่าน Bot Framework Emulator + ngrok ก่อน (ดู Solo Sprint Plan §Tech Stack)

---

## 📊 หลัง Smoke Test ผ่าน

- [ ] อัด demo recording 3-5 นาที (ดู [demo-script.md](./demo-script.md))
- [ ] เลือก Beta Squad 5–8 คน (ดู [handoff-package.md](./handoff-package.md) §3 Selection Criteria)
- [ ] ส่ง Founding Member invitation (1:1 Teams DM ตาม template)
- [ ] รายงานกลับให้ผม → จะ update [Run Log](https://www.notion.so/454eea66a32345d59d7f9cf4ea3971f5)

---

## 🆘 ถ้าติด

- **Router accuracy < 80%** → paste 5 cases ที่ผิดให้ผม → iterate router prompt
- **HR Bot hallucinate** → tighten refusal rule + เพิ่ม seed KB
- **Latency > 10s** → เช็ค Anthropic Prompt Caching เปิดถูกไหม (system block + cache_control)
- **Cost พุ่ง** → เช็ค Pre-AI Cache hit rate + token caps

มี blocker ที่ไหนตอบกลับมา ผมช่วยแก้ครับ
