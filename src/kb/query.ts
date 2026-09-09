export interface QueryTurn { role: 'user' | 'assistant'; content: string }

/** Vocabulary only: never supplies a policy fact or an employee identity. */
export function canonicalQuery(text: string): string {
  return text.normalize('NFC').toLowerCase()
    .replace(/ไทม[์ื]?ช[ีิ][ทต]|time\s*sheet/gi, 'timesheet')
    .replace(/ฮิวแมนซอฟ[ตท์]*|human\s*soft/gi, 'humansoft')
    .replace(/พจมาน|pojjaman|\bpjm\b/gi, 'pojjaman')
    .replace(/ลิงค์|ลิ้งก์|ลิ้งค์|\blink\b/gi, 'ลิงก์');
}

const HAS_TOPIC = /timesheet|humansoft|วันลา|ลาป่วย|ลากิจ|พักร้อน|วันหยุด|กองทุน|ค่าน้ำมัน|ค่าเดินทาง|กีฬาสี|ห้องประชุม|ภาษี|ที่อยู่|เบอร์|ติดต่อ|plo[y]|พลอย|jubili|insite/i;
const FOLLOW_UP = /^(?:ขอ|แล้ว|เพิ่ม|แก้|วิธี|ขั้นตอน|ลิงก์|เอกสาร|แบบฟอร์ม|อันนี้|อันนั้น)|^(?:pojjaman|humansoft|ระบบ\s*pojjaman|ระบบ\s*humansoft)(?:\s|ครับ|ค่ะ|$)/i;

/** Only short referential turns inherit user context. Assistant guesses never
 * become retrieval facts, and an explicit topic switch drops old context. */
export function retrievalQuery(question: string, history: readonly QueryTurn[] = []): string {
  const q = canonicalQuery(question);
  const systemAnswer = /^(?:ระบบ\s*)?(?:pojjaman|humansoft)(?:\s*(?:ครับ|ค่ะ|คะ))?$/i.test(q.trim());
  if ((!systemAnswer && HAS_TOPIC.test(q)) || q.length > 100 || !FOLLOW_UP.test(q.trim())) return q;
  const previous = history.filter(m => m.role === 'user').slice(-4).map(m => canonicalQuery(m.content));
  const qualifiers: string[] = [];
  for (const t of previous.reverse()) {
    if (/^(?:ระบบ\s*)?(?:pojjaman|humansoft)(?:\s*(?:ครับ|ค่ะ|คะ))?$/i.test(t.trim())) { qualifiers.unshift(t); continue; }
    if (HAS_TOPIC.test(t)) return [t, ...qualifiers, q].join('\n');
    if (t.length > 100 || !FOLLOW_UP.test(t.trim())) break;
  }
  return q;
}

export function queryConcepts(text: string): string[] {
  const q = canonicalQuery(text);
  const concepts: [string, RegExp][] = [
    ['timesheet', /timesheet/], ['leave', /วันลา|การลา|ลาป่วย|ลากิจ|ลาพัก|พักร้อน|\bleave\b/],
    ['holiday', /วันหยุด|\bholidays?\b/], ['address', /ที่อยู่|เดินทางมาออฟฟิศ|\baddress\b/],
    ['provident', /กองทุน|provident/], ['travel', /ค่าเดินทาง|ค่าน้ำมัน/],
  ];
  return concepts.filter(([, re]) => re.test(q)).map(([name]) => name);
}
