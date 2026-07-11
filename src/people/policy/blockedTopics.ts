// People Connector — blocked-topic + injection patterns (plan §8). Data only, no
// logic, so non-devs can tune keywords without touching the gate. Matched against
// the NFC-lowercased query. Fail-closed: when a person-data topic (salary/leave/
// health/…) appears we REFUSE even if phrased as "who owns X" — privacy beats a
// rare false refusal; refine later with a topic-vs-subject distinction.

export interface BlockedCategory {
  code: string;
  re: RegExp;
}

/** Ordered; first match wins (only the code differs — all → REFUSE). */
export const BLOCKED_CATEGORIES: readonly BlockedCategory[] = [
  { code: "salary", re: /เงินเดือน|ค่าจ้าง|รายได้|โบนัส|ปรับเงิน|ฐานเงินเดือน|รหัสเงินเดือน|salary|bonus|compensation|payroll/ },
  { code: "leave", re: /วันลา|ลาป่วย|ลากิจ|ลาพักร้อน|วันหยุดพักร้อน|leave balance|sick leave/ },
  { code: "health", re: /สุขภาพ|ป่วยเป็น|โรคประจำ|ประวัติการรักษา|health record|medical (record|history)/ },
  { code: "performance", re: /ผลประเมิน|ประเมินผล|เกรดพนักงาน|performance review|appraisal|kpi ของ|kpi ราย/ },
  { code: "ranking", re: /ใครเก่ง|เก่งสุด|ใครแย่|แย่สุด|ทำงานน้อย|ขยันสุด|ขี้เกียจ|จัดอันดับ.*(พนักงาน|คน)|เยอะสุด|ลาบ่อยสุด|เกรดแย่|who is (the )?(best|worst|laziest|smartest)|rank (the )?employees/ },
  { code: "attrition", re: /จะลาออก|กำลังจะออก|ทำนาย.*ลาออก|ข่าวลือ|นินทา|ซุบซิบ|gossip|attrition|going to resign/ },
  { code: "enumeration", re: /พนักงานทั้งหมด|ทั้งบริษัท|ทุกคนในบริษัท|รายชื่อทั้งหมด|ทั้งหมดในบริษัท|พนักงานทุกคน|โปรไฟล์.*ทุกคน|all employees|everyone in the (company|org)|entire company|whole company|list all (employees|people|staff)|every (employee|staff|person)|dump .*(employee|directory|profile|record)/ },
  { code: "private", re: /เบอร์(โทร)?ส่วนตัว|ที่อยู่บ้าน|บ้านเลขที่|เลขบัตรประชาชน|บัตรประชาชน|personal phone|home address|national id|id card/ },
  { code: "field", re: /\brank\b|rank code|เรทติ้งพนักงาน|คำนำหน้า/ },
];

/** Prompt-injection attempts that try to dump the directory or non-allowlist fields. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |the )?(previous |above )?(instructions|rules)/,
  /disregard (all |the )?(previous|above)/,
  /reveal (the )?(system prompt|directory)/,
  /show (me )?(all|every) (field|fields|profiles|employees|data)/,
  /list all (fields|profiles|employees|data)/,
  /system prompt/,
  /jailbreak|bypass (the )?(rule|filter|guard)/,
  /เพิกเฉย.*(คำสั่ง|กฎ)|ข้ามกฎ|ยกเลิกคำสั่ง/,
  /แสดง.*(ทุก\s*field|ทุกฟิลด์|field ทั้งหมด|directory ทั้งหมด|ข้อมูลทั้งหมดของ)/,
  /เปิด(เผย)?\s*system prompt/,
];
