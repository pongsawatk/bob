# Knowledge Base Changelog

> Append-only — ห้ามแก้ entry เก่า ใช้ entry ใหม่แทน
> Format: `YYYY-MM-DDTHH:MM:SS+07:00 | path | by | reason`

---

2026-05-08T00:00:00+07:00 | knowledge-base/ | jor | initial scaffold (Karpathy 3-layer pattern)
2026-05-08T00:00:00+07:00 | schema/CLAUDE.md | jor | initial generic convention
2026-05-08T00:00:00+07:00 | schema/BOB.md | jor | initial BOB-specific schema
2026-05-08T15:30:00+07:00 | wiki/hr/* (23 files) | ai-assistant | seed HR KB จาก raw/hr/* (29 files OneDrive) → Notion DB → wiki — bundle ready for system prompt
2026-05-08T15:30:00+07:00 | wiki/process/* (11 files) | ai-assistant | seed PROCESS KB (Pojjaman/office/locker/business-card/timesheet/Line of Approval/announcements)
2026-05-08T15:35:00+07:00 | scripts/build-kb-bundle.mjs | ai-assistant | build script — concatenate wiki/*.md → dist/hr-bundle.md / dist/product-bundle.md
2026-05-08T15:35:00+07:00 | knowledge-base/index.md | ai-assistant | content catalog — 34 wiki pages indexed
