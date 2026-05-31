# CLAUDE.md — AI Maintainer Convention (Generic)

> **Audience:** AI Maintainer (Claude Sonnet 4.6) ที่แก้ไข `wiki/*.md` ผ่าน Workflow D
> **Purpose:** Single source-of-truth สำหรับ heading / citation / tone convention
> **Reference:** Karpathy LLM Wiki gist · SDD §Wiki Architecture · KB Management Guide §Maintainer Schema

---

## File Layout

```
knowledge-base/
├── raw/         # Immutable source — ห้ามแก้ ห้ามลบ (Notion link, .docx, transcript)
├── wiki/        # LLM-maintained articles — แก้ผ่าน Workflow D เท่านั้น
├── schema/
│   ├── CLAUDE.md   # ไฟล์นี้ — generic convention
│   └── BOB.md      # BOB-specific maintainer schema (อ่านควบคู่)
├── index.md     # Content catalog (auto-generated)
└── log.md       # Append-only changelog
```

## Heading Conventions

- `#` H1 = หัวข้อหลักของ wiki page (1 page = 1 H1 เท่านั้น)
- `##` H2 = sub-topic (เช่น "เงื่อนไข", "ขั้นตอน", "ข้อยกเว้น")
- `###` H3 = sub-sub-topic — **ห้ามลึกกว่านี้**
- ห้ามใช้ H4+ — ถ้าต้องการแยก ใช้ bullet list หรือแยก wiki page

## Citation Format

**บังคับทุก fact:**

```markdown
- พนักงานสามารถลาพักร้อนได้ 6 วัน/ปี [source: raw/hr/leave-policy-2026.md]
- เบิกค่าเดินทางต้องใช้ใบเสร็จ + ใบขออนุมัติ [source: raw/hr/expense-process.md]
```

**กฎ:**
1. Citation ต่อท้าย claim เสมอ — ห้ามวางหน้า claim
2. Path เป็น `raw/{category}/{filename}.md` — ห้าม inline URL ในเนื้อหา
3. ถ้าหลาย source: `[source: raw/hr/a.md, raw/hr/b.md]`
4. ถ้าไม่มี raw source → ห้าม claim → ลบทิ้งหรือเปลี่ยนเป็น "[NEEDS SOURCE]" (Workflow D จะ flag)
5. Citation Check (Workflow C/D) จะ reject page ที่มี fact ไม่มี source

## YAML Frontmatter (บังคับทุก wiki page)

```yaml
---
doc_id: KB-1
category: HR | PRODUCT | PROCESS
topic: หัวข้อหลักของ page นี้
keywords: [คำสำคัญ1, คำสำคัญ2]
volatility: T1 | T2 | T3 | T4
last_reviewed: 2026-05-08
contributed_by: ชื่อผู้ส่ง
sources:
  - raw/hr/welfare-2026.md
  - raw/hr/policy-update-q1.md
status: published
---
```

## Volatility Tiers

| Tier | ตัวอย่าง | Storage | กฎ |
|---|---|---|---|
| T1 Stable | HR Policy, Product spec | Wiki (in-prompt) | ปกติ |
| T2 Moderate | FAQ, use case | Wiki + weekly rebuild | ปกติ |
| T3 Volatile | **Pricing, Promo, Stock** | RAG / API | **ห้ามใส่ wiki** |
| T4 Real-time | Ticket status, Account | Live API | **ห้ามใส่ wiki** |

## Tone & Style

- ภาษาไทย เป็นทางการระดับกลาง (ไม่ทางการเกินไป ไม่ casual เกินไป)
- ลงท้าย "ครับ" — เป็น tone ของ BOB
- กระชับ — bullet ดีกว่า paragraph
- ห้าม emoji ในเนื้อหา wiki (ใส่ใน UI/feedback ได้)
- ห้ามใช้คำว่า "กรุณา" — ใช้ "ขอแนะนำ" หรือ "แนะนำให้" แทน
- 1 paragraph ≤ 3 บรรทัด

## Forbidden Actions

❌ **ห้ามแก้** `raw/*` เด็ดขาด (immutable)
❌ **ห้ามลบ** `raw/*` แม้ deprecated → ใช้ `status: deprecated` ใน frontmatter
❌ **ห้าม edit** `wiki/*` ตรงๆ → ต้องผ่าน Workflow D
❌ **ห้าม mix model** — Maintainer ใช้ Sonnet 4.6 เท่านั้น
❌ **ห้าม fact** ที่ไม่มี source citation
❌ **ห้ามเดา** — ถ้าไม่แน่ใจ ใช้ `[NEEDS SOURCE]` แล้ว flag

## Update Protocol

1. รับ `raw/` source ใหม่/เปลี่ยน → fetch ทุก wiki page ที่อ้างอิง source นั้น
2. Update wiki + verify citation ครบ
3. Append entry ใน `log.md` เป็น `YYYY-MM-DD | wiki/path | changed_by | reason`
4. Trigger Workflow E (Smoke Test) สำหรับ category ที่กระทบ
5. ถ้ามี conflict 2 Champion แก้ page เดียวกันใน 24 ชม. → escalate Jor manual merge

## Spot-Check Sampling (Champion task)

ทุกสัปดาห์ Champion สุ่ม 5 wiki pages → เทียบ raw → คำนวณ:
```
drift_score = correct_facts / total_facts
target: > 0.95
```

ถ้า < 0.95 → flag เป็น P0 + เปิด Workflow D fix immediately
