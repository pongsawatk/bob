// Tier 0: Pre-AI cache — regex/keyword short-circuit before any LLM call.
// Returns a pre-canned answer or null (meaning: proceed to router).

interface PrecacheHit {
  answer: string;
  category: "HR" | "GENERAL";
}

// Simple keyword → instant response map (seed from common questions)
const FAQ: Array<{ pattern: RegExp; answer: string; category: "HR" | "GENERAL" }> = [
  {
    pattern: /^(สวัสดี|หวัดดี|hello|hi|ดี|เฮ้|เฮย)[ๆ\s!]*$/i,
    category: "GENERAL",
    answer:
      "สวัสดีครับ! ผม BOB ผู้ช่วยของ Builk One ครับ\n" +
      "ถามเรื่องไหนได้เลยครับ:\n" +
      "• HR — สวัสดิการ ลา OT เบิกเงิน\n" +
      "• Product — Insite, Pojjaman, Builk360, JUBILI",
  },
  {
    pattern: /^(ขอบคุณ|thanks|thank you|ขอบใจ)[ๆ\s!]*$/i,
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
  return null;
}
