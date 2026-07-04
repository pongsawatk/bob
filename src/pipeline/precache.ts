// Tier 0: Pre-AI cache — regex/keyword short-circuit before any LLM call.
// Returns a pre-canned answer or null (meaning: proceed to router).

import { remainingHolidaysBlock } from "../kb/holidays.js";

interface PrecacheHit {
  answer: string;
  category: "HR" | "GENERAL";
}

// Deterministic answer for "วันหยุดเหลือกี่วัน" — the #1 suggested question from the
// welcome card (~27% of traffic) whose answer is already precomputed in kb/holidays.ts,
// so an LLM call (10-20s, HR bundle context) buys nothing. Guards are strict:
// must be a short question about REMAINING company holidays; anything scoped to a
// month/festival or about personal leave quota (วันลา → HumanSoft) goes to the LLM.
function checkHolidayPrecache(message: string): PrecacheHit | null {
  const m = message.trim();
  if (m.length > 60) return null;
  if (!/วันหยุด/.test(m)) return null;
  if (!/เหลือ|ยังไม่ถึง/.test(m)) return null;
  if (!/กี่วัน|วันไหน|อะไรบ้าง|เท่าไหร่|เท่าไร/.test(m)) return null;
  // Needs KB/LLM nuance: month/festival scoping, leave quota, other years.
  if (/เดือน|สัปดาห์|อาทิตย์|วันลา|ลาพักร้อน|ลาป่วย|ลากิจ|สงกรานต์|ปีหน้า|ปีที่แล้ว|\b25[67]\d\b/.test(m)) return null;

  const block = remainingHolidaysBlock();
  if (!block) return null; // no dataset for this year → let the LLM handle it
  return {
    category: "HR",
    answer: `${block}\n\nมีอะไรให้ช่วยเพิ่มไหมครับ? 😊`,
  };
}

// Simple keyword → instant response map (seed from common questions)
const FAQ: Array<{ pattern: RegExp; answer: string; category: "HR" | "GENERAL" }> = [
  {
    pattern: /^(สวัสดี|หวัดดี|hello|hi|ดี|เฮ้|เฮย)[ๆ\s!]*(ครับ|คับ|ค่ะ|คะ|จ้า|ฮะ)?[ๆ\s!]*$/i,
    category: "GENERAL",
    answer:
      "สวัสดีครับ! ผม BOB ผู้ช่วยของ Builk One ครับ\n" +
      "ถามเรื่องไหนได้เลยครับ:\n" +
      "• HR — สวัสดิการ ลา OT เบิกเงิน\n" +
      "• Product — Insite, Pojjaman, Builk360, JUBILI",
  },
  {
    pattern: /^(ขอบคุณ|thanks|thank you|ขอบใจ)[ๆ\s!]*(มาก|ครับ|คับ|ค่ะ|คะ|จ้า|ฮะ)*[ๆ\s!]*$/i,
    category: "GENERAL",
    answer: "ยินดีครับ! มีอะไรให้ช่วยอีกไหมครับ?",
  },
];

export function checkPrecache(message: string): PrecacheHit | null {
  const trimmed = message.trim();
  for (const item of FAQ) {
    if (item.pattern.test(trimmed)) {
      return { answer: item.answer, category: item.category };
    }
  }
  return checkHolidayPrecache(trimmed);
}
