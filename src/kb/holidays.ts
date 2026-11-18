// Precomputed company holiday list so the model never has to do date math itself.
// Real cause of past errors: BOB counted "วันหยุดเหลือกี่วัน" by reasoning over the
// KB table + today's date and got it wrong (e.g. answered 11 when it was 7, or
// dropped a day). We compute the remaining list here and inject it into the HR
// prompt, then instruct the model to read it verbatim.
//
// ⚠️ UPDATE YEARLY: this mirrors knowledge-base/wiki/hr/holidays-2569.md (พ.ศ. 2569 /
// ค.ศ. 2026). When 2570 is announced, add HOLIDAYS_2570 and bump DATASET_YEAR logic.

export interface Holiday {
  /** ISO date (Gregorian) for reliable comparison, e.g. "2026-07-28". */
  date: string;
  /** Thai display exactly as in the KB doc, e.g. "อังคาร 28 ก.ค.". */
  display: string;
  name: string;
}

// พ.ศ. 2569 = ค.ศ. 2026. Source: knowledge-base/wiki/hr/holidays-2569.md
const HOLIDAYS_2569: Holiday[] = [
  { date: "2026-01-01", display: "พฤ. 1 ม.ค.", name: "วันขึ้นปีใหม่" },
  { date: "2026-03-03", display: "อังคาร 3 มี.ค.", name: "วันมาฆบูชา" },
  { date: "2026-04-06", display: "จันทร์ 6 เม.ย.", name: "วันพระบาทสมเด็จพระพุทธยอดฟ้าจุฬาโลกฯ + วันที่ระลึกมหาจักรีบรมราชวงศ์" },
  { date: "2026-04-13", display: "จันทร์ 13 เม.ย.", name: "วันสงกรานต์" },
  { date: "2026-04-14", display: "อังคาร 14 เม.ย.", name: "วันสงกรานต์" },
  { date: "2026-04-15", display: "พุธ 15 เม.ย.", name: "วันสงกรานต์" },
  { date: "2026-05-01", display: "ศุกร์ 1 พ.ค.", name: "วันแรงงานแห่งชาติ" },
  { date: "2026-05-04", display: "จันทร์ 4 พ.ค.", name: "วันฉัตรมงคล" },
  { date: "2026-06-01", display: "จันทร์ 1 มิ.ย.", name: "ชดเชยวันวิสาขบูชา (อาทิตย์ 31 พ.ค.)" },
  { date: "2026-06-03", display: "พุธ 3 มิ.ย.", name: "วันเฉลิมฯ สมเด็จพระนางเจ้าสุทิดาฯ" },
  { date: "2026-07-28", display: "อังคาร 28 ก.ค.", name: "วันเฉลิมฯ พระบาทสมเด็จพระเจ้าอยู่หัว" },
  { date: "2026-07-29", display: "พุธ 29 ก.ค.", name: "วันอาสาฬหบูชา" },
  { date: "2026-08-12", display: "พุธ 12 ส.ค.", name: "วันเฉลิมฯ สมเด็จพระนางเจ้าสิริกิติ์ฯ + วันแม่" },
  { date: "2026-10-13", display: "อังคาร 13 ต.ค.", name: "วันนวมินทรมหาราช" },
  { date: "2026-10-23", display: "ศุกร์ 23 ต.ค.", name: "วันปิยมหาราช" },
  { date: "2026-12-07", display: "จันทร์ 7 ธ.ค.", name: "ชดเชยวันคล้ายวันพระบรมราชสมภพ ร.9 + วันชาติ + วันพ่อ (เสาร์ 5 ธ.ค.)" },
  { date: "2026-12-31", display: "พฤ. 31 ธ.ค.", name: "วันสิ้นปี" },
];

const DATASET: Record<number, Holiday[]> = { 2026: HOLIDAYS_2569 };

const MONTHS = [
  ['มกราคม', 'มกรา', 'ม.ค.'], ['กุมภาพันธ์', 'กุมภา', 'ก.พ.'], ['มีนาคม', 'มีนา', 'มี.ค.'],
  ['เมษายน', 'เมษา', 'เม.ย.'], ['พฤษภาคม', 'พฤษภา', 'พ.ค.'], ['มิถุนายน', 'มิถุนา', 'มิ.ย.'],
  ['กรกฎาคม', 'กรกฎา', 'ก.ค.'], ['สิงหาคม', 'สิงหา', 'ส.ค.'], ['กันยายน', 'กันยา', 'ก.ย.'],
  ['ตุลาคม', 'ตุลา', 'ต.ค.'], ['พฤศจิกายน', 'พฤศจิกา', 'พ.ย.'], ['ธันวาคม', 'ธันวา', 'ธ.ค.'],
] as const;

/** Answer only an unambiguous date list/count. Leave multi-part and policy
 * questions to the HR answerer, including years beyond the curated calendar. */
export function calendarAnswer(question: string, now = new Date()): string | undefined {
  if (!/หยุด/.test(question)) return;
  let rest = question.trim().replace(/\s+/g, '');
  const current = bangkokISO(now);
  let year = Number(current.slice(0, 4));
  let month: number | undefined;
  const explicit = /(?:พ\.ศ\.|ค\.ศ\.)?(?:25\d{2}|20\d{2})|(?:ประจำ)?ปี(\d{2})(?!\d)|ปี(นี้|หน้า|ที่แล้ว)/.exec(rest);
  if (explicit) {
    if (explicit[2]) year += explicit[2] === 'หน้า' ? 1 : explicit[2] === 'ที่แล้ว' ? -1 : 0;
    else {
      const n = explicit[1] ? 2500 + Number(explicit[1]) : Number(explicit[0].replace(/\D/g, ''));
      year = n >= 2500 ? n - 543 : n;
    }
    rest = rest.replace(explicit[0], '');
  }
  for (const [index, aliases] of MONTHS.entries()) {
    const alias = aliases.find(name => rest.includes(name));
    if (alias) {
      if (month !== undefined) return;
      month = index + 1;
      rest = rest.replace(alias, '');
    }
  }
  if (month === undefined && !explicit) return;
  // Remaining text must describe only the calendar, never silently ignore e.g.
  // a named holiday, a second question, a specific date, or a leave request.
  rest = rest.replace(/วันหยุดนักขัต(?:ฤกษ์|ฤกต์)|วันหยุดตามประเพณี|วันหยุด|หยุด|ประจำปี|ปี|เดือน|บริษัท|วันไหนบ้าง|วันไหน|กี่วัน|อะไรบ้าง|มี|ขอ|รายการ|ทั้งหมด|บ้าง|ครับ|ค่ะ|คะ|[?？]/g, '');
  if (rest || !DATASET[year]) return;
  const dates = DATASET[year]!.filter(h => !month || Number(h.date.slice(5, 7)) === month);
  const period = (month ? MONTHS[month - 1]![0] + ' ' : '') + (year + 543);
  return [`วันหยุดบริษัท${month ? 'เดือน' : 'ปี '}${period} มี ${dates.length} วันครับ`,
    ...dates.map(h => `- ${h.display} — ${h.name}`),
    'อ้างอิง: https://outline.builk.id/doc/2569-791DOshv2d'].join('\n');
}

/** Today's date in Asia/Bangkok as "yyyy-mm-dd" (en-CA yields ISO order). */
function bangkokISO(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * A ready-made "remaining company holidays" block for the HR prompt, computed from
 * today's date — so the model reports the count/list instead of calculating it.
 * Returns "" for years we don't have data for (model falls back to the KB table).
 */
export function remainingHolidaysBlock(now: Date = new Date()): string {
  const today = bangkokISO(now);
  const year = Number(today.slice(0, 4));
  const list = DATASET[year];
  if (!list) return ""; // no dataset for this year → don't assert anything; KB table is the fallback

  const remaining = list.filter((h) => h.date >= today);
  if (remaining.length === 0) {
    return "วันหยุดบริษัทประจำปีนี้ผ่านครบหมดแล้ว ไม่มีวันหยุดเหลือในปีนี้";
  }
  const lines = remaining.map((h) => `- ${h.display} — ${h.name}`).join("\n");
  return (
    `วันหยุดบริษัทที่ยังไม่ถึง (นับจากวันนี้) มีทั้งหมด ${remaining.length} วัน:\n${lines}`
  );
}
