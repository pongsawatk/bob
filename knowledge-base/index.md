# BOB Knowledge Base — Content Catalog

> **Last rebuild:** 2026-05-09
> **Source of truth:** Notion DB [BOB Knowledge Base](https://www.notion.so/f8768020d1a54f668efbd757d99b6ae9)
> **Sync:** Day 1 = manual `node scripts/build-kb-bundle.mjs` · Week 2+ = n8n Workflow F (Wiki Sync)

## Stats

- Total wiki pages: **34** (HR: 26 · Process: 8 · Product: 0)
- Total raw sources: 29 .txt files (HR KB folder)
- Categories covered: HR · PROCESS

## HR (26 pages)

### Culture
- [core-values.md](wiki/hr/core-values.md) — Core Values & Expected Behaviors (BUILK ONE)

### Leave
- [leave-sick.md](wiki/hr/leave-sick.md) — ลาป่วย (≤ 30 วัน/ปี)
- [leave-personal.md](wiki/hr/leave-personal.md) — ลากิจ (≤ 7 วัน/ปี)
- [leave-maternity.md](wiki/hr/leave-maternity.md) — ลาคลอด (98 วัน + 15K บ.)
- [leave-others.md](wiki/hr/leave-others.md) — ลาทหาร อุปสมบท ฮัจญ์ ทำหมัน ฝึกอบรม WOP
- [leave-humansoft-rules.md](wiki/hr/leave-humansoft-rules.md) — กฎห้ามคร่อมวันหยุดในระบบ
- [humansoft-manuals.md](wiki/hr/humansoft-manuals.md) — คู่มือ HumanSoft

### Time & Workplace
- [holidays-2568.md](wiki/hr/holidays-2568.md) — วันหยุดประจำปี 2568
- [holidays-2569.md](wiki/hr/holidays-2569.md) — วันหยุดประจำปี 2569
- [workplace-policy.md](wiki/hr/workplace-policy.md) — สถานที่ทำงาน วันทำงาน เวลางาน

### People
- [employee-directory.md](wiki/hr/employee-directory.md) — Employee Directory (147 คน)
- [work-rules-overview.md](wiki/hr/work-rules-overview.md) — ข้อบังคับเกี่ยวกับการทำงาน Overview

### Compensation
- [expense-cycle-rules.md](wiki/hr/expense-cycle-rules.md) — FAQ ระเบียบเบิกค่าใช้จ่าย
- [per-diem-rates.md](wiki/hr/per-diem-rates.md) — เบี้ยเลี้ยง ที่พัก น้ำมัน

### Benefits
- [provident-fund.md](wiki/hr/provident-fund.md) — กองทุนสำรองเลี้ยงชีพ
- [social-security.md](wiki/hr/social-security.md) — ประกันสังคม
- [annual-health-checkup.md](wiki/hr/annual-health-checkup.md) — ตรวจสุขภาพประจำปี
- [mobile-phone-policy.md](wiki/hr/mobile-phone-policy.md) — โทรศัพท์เคลื่อนที่ (ยกเลิก)
- [computer-it-policy.md](wiki/hr/computer-it-policy.md) — คอมพิวเตอร์ IT
- [asset-borrow-return.md](wiki/hr/asset-borrow-return.md) — ยืม/คืนสินทรัพย์
- [team-budget-policy.md](wiki/hr/team-budget-policy.md) — Team Budget
- [birthday-voucher.md](wiki/hr/birthday-voucher.md) — Birthday Voucher
- [external-training.md](wiki/hr/external-training.md) — ฝึกอบรมภายนอก
- [future-skill-online-course.md](wiki/hr/future-skill-online-course.md) — Future Skill

### Work Rules (Discipline & Termination)
- [discipline-and-penalties.md](wiki/hr/discipline-and-penalties.md) — หมวด 8 วินัยและโทษ + ม. 119
- [termination-and-severance.md](wiki/hr/termination-and-severance.md) — หมวด 10 พ้นสภาพ เกษียณ ค่าชดเชย

## PROCESS (8 pages)

### Office
- [office-rules.md](wiki/process/office-rules.md) — อาคารรุ่งโรจน์ธนกุล
- [locker-rules.md](wiki/process/locker-rules.md) — ระเบียบล็อคเกอร์
- [business-card-request.md](wiki/process/business-card-request.md) — ขอทำนามบัตร

### Pojjaman System
- [pojjaman-login-builk.md](wiki/process/pojjaman-login-builk.md) — Login ด้วย @builk.com
- [timesheet-pojjaman.md](wiki/process/timesheet-pojjaman.md) — บันทึก Timesheet
- [expense-pojjaman-howto.md](wiki/process/expense-pojjaman-howto.md) — ขั้นตอนเบิก OT/เบี้ยเลี้ยง
- [line-of-approval.md](wiki/process/line-of-approval.md) — Line of Approval (51 เอกสาร)

### Reference
- [announcements-index.md](wiki/process/announcements-index.md) — ลิงค์ประกาศ SharePoint

## PRODUCT (0 pages — Day 2+)
_(seed from Notion DB → category=PRODUCT → status=published)_

---

## Sync Status

| Source | Wiki | Last Synced | Status |
|---|---|---|---|
| Notion DB `cebe1fb0-e7ad-4ac5-9ab0-45e826025099` | `wiki/` | 2026-05-09 (manual index sync) | up-to-date |
| OneDrive `OneDrive/03 Product Development/One bot/HR KB/` | `raw/hr/` | reference only | — |

## Build

```bash
# Generate dist/hr-bundle.md, dist/product-bundle.md, dist/all-bundle.md
cd scripts && node build-kb-bundle.mjs
```

After build, copy `dist/hr-bundle.md` content into n8n HR Bot system prompt at `<<HR_KB_BUNDLE>>` placeholder.
