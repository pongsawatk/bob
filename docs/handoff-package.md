# BOB Sidekick — Beta Squad Handoff Package

> **Framing:** "BOB Founding Members" (อิง Solo Sprint Plan §Layer 1 Seeding)
> **Goal:** ชวน 5–8 Bridge Influencers ทดลองใช้ + ให้ feedback ที่จะ shape DNA ของ BOB

---

## 1. Founding Member Invitation Message

**ส่งใน Teams DM (1:1) — ไม่ใช่ broadcast**

```
สวัสดีครับ พี่/น้อง [ชื่อ]

ผมเพิ่งสร้าง BOB — Builk One Bot ผู้ช่วย AI สำหรับองค์กรเรา
ตอบเรื่อง HR (สวัสดิการ ลา OT) และ Product (Insite Pojjaman Builk360 JUBILI) ได้

ตอนนี้ที่ผมต้องการคือ **8 คนแรก** ที่ peers ฟัง — เลยนึกถึง [ชื่อ] ครับ
อยากชวนเป็น "BOB Founding Member"

สิ่งที่ขอ:
- ทดลองใช้ใน Teams 2-3 สัปดาห์
- บอกตรงๆ ว่ามันใช้ดีไม่ดียังไง
- คำถามที่มันตอบไม่ได้

สิ่งที่ได้:
- ความคิดเห็นของพี่จะเขียนใน DNA ของ BOB ตลอดไป
- เห็น behind-the-scenes ของ AI project ในองค์กรเรา
- กลุ่ม Founding Members exclusive — Jor คุยกับทุกคน 1:1

สนใจไหมครับ? ถ้าใช่ผมส่ง onboarding ให้พรุ่งนี้
```

---

## 2. Onboarding Pack (ส่งหลังตอบรับ)

### Bot Access

```
1. เปิด MS Teams
2. คลิก link นี้: [TEAMS_BOT_DEEPLINK]
3. กด Add → BOB จะปรากฏใน Chat panel ซ้าย
4. พิมพ์ "สวัสดี" เพื่อเริ่ม
```

### 3 Sample Questions ลองได้เลย

```
1. "ผมจะลาพักร้อนต้องทำยังไง"  ← test HR knowledge
2. "Builk Insite เหมาะกับลูกค้ากลุ่มไหน"  ← test Product knowledge
3. "ราคา Insite Pro เท่าไหร่"  ← test refusal (volatile data)
```

### What to Expect

✅ **BOB จะ:**
- ตอบเป็นภาษาไทย ลงท้าย "ครับ"
- อ้างอิง source ทุกคำตอบ — ตรวจสอบได้
- บอกตรงๆ ถ้าไม่รู้ — ไม่เดา
- ปฏิเสธคำถามเรื่องราคา/promo (ส่งต่อทีม Sales)

⚠️ **BOB ยังไม่:**
- ตอบเรื่อง Finance details
- รู้ Personal context (ดูข้อมูลส่วนตัวพี่ไม่ได้)
- ตอบเรื่อง roadmap product ในรายละเอียด
- ทำหน้าที่ HR officer (เป็น assistant ไม่ใช่ decision maker)

### Feedback ทำยังไง

```
ทุก response มีปุ่ม:
👍 ถูกต้อง            ← กดถ้าตอบดี
👎 ไม่ถูก/ไม่ครบ      ← กดถ้าผิดหรือขาด
📝 ฉันรู้คำตอบที่ดีกว่า  ← กดเพื่อเพิ่ม knowledge
🧩 ขอ example เพิ่ม    ← กดถ้าอยากได้ตัวอย่างเพิ่ม
```

**Jor commitment:** ตอบทุก feedback ภายใน 24 ชม. (ใน Beta phase)

### Direct Channel

ถ้าเจอ bug หรืออยากแชท → DM Jor ใน Teams ได้เลย
หรือ post ใน Teams group "BOB Founding Members" (จะสร้างหลังครบ 8 คน)

---

## 3. Beta Squad Selection Criteria

**เลือกคนที่:**
- [ ] เป็น peers influencer — เพื่อนๆ ฟังเขา (ไม่ใช่ผู้บริหาร)
- [ ] อยู่ในงานที่ถามคำถามซ้ำๆ บ่อย (Sales, HR support, Engineer onboarding)
- [ ] ไม่กลัว AI / open to test new tools
- [ ] ให้ feedback ตรงๆ ได้ ไม่เกรงใจ

**คนที่จะเชิญ (Jor list):**
- [ ] Sales senior 2 คน ____________ ____________
- [ ] HR senior 1 คน ____________
- [ ] Engineer / Tech lead 1 คน ____________
- [ ] Consulting / Project manager 1 คน ____________
- [ ] Onboarding-recently joined 1 คน (เพราะถามเยอะ) ____________
- [ ] Wild card 2 คน ____________ ____________

---

## 4. Known Limitations (โปร่งใสตั้งแต่วันแรก)

### ตอนนี้ (Day 1)
- KB seed มี 10 หัวข้อ HR + 10 หัวข้อ Product เท่านั้น
- ไม่มี integration กับ HRIS หรือ Pojjaman ของ user
- ไม่ดึงแผนก/ตำแหน่งจาก Azure AD (จะเพิ่ม Week 2)
- Latency P95 ~ 5 วินาที สำหรับ Product (Sonnet 4.6)
- ไม่มี multi-turn memory ในเซสชัน — แต่ละ message อยู่แยกกัน

### Roadmap
- Week 2: Microsoft Graph API → ดึงแผนก + ตำแหน่ง auto
- Week 2: Knowledge Submission Form (Workflow C) → Champions เพิ่ม knowledge ได้เอง
- Week 3: Multi-turn conversation memory
- Week 4: Teams Admin Push → org-wide

---

## 5. Engagement Anchors (สิ่งที่ต้องทำหลัง onboard)

### ในสัปดาห์แรก
- [ ] Founding Member แต่ละคนใช้อย่างน้อย 5 ครั้ง
- [ ] Friction Removal Patrol — Jor นั่งดู log แล้ว DM ทักผู้ที่ติดขัดเป็น personal
- [ ] First Conversation Ritual — Bot ทักผู้ใช้ใหม่ + 3 sample buttons

### สัปดาห์ที่ 2-3
- [ ] "Stump the BOB" Challenge — หา Q ที่ Bot ตอบไม่ได้ + ส่ง correct answer = +20 Builk Points
- [ ] Public Wall of Fame ใน Teams channel
- [ ] Embed in Monday standup — ถาม BOB question of the week

### สัปดาห์ที่ 4 (จบ Phase 0)
- [ ] Founding Member retro 30 นาที
- [ ] Beta squad ขึ้นเล่า origin story ใน Town Hall (ไม่ใช่ Jor!)
- [ ] Decision: ขยาย / IT push

---

## 6. Communication Cadence

| When | What | Channel |
|---|---|---|
| Day 0 | Founding Member 1:1 invite | Teams DM |
| Day 1 | Onboarding pack + 3 sample questions | Teams DM |
| Day 2-7 | Daily check-in "ลองใช้แล้วเป็นไงบ้าง" | Teams DM (informal) |
| Week 2 | BOB Bulletin #1 — Top 5 Q this week | Teams group post |
| Week 3 | Stump the BOB Challenge launch | Teams group + email |
| Week 4 | Beta Retrospective | 30-min call + survey |
