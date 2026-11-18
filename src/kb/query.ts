export interface QueryTurn { role: 'user' | 'assistant'; content: string }

/** Vocabulary only: never supplies a policy fact or an employee identity. */
export function canonicalQuery(text: string): string {
  return text.normalize('NFC').toLowerCase()
    .replace(/ไทม[์ื]?ช[ีิ][ทต]|time\s*sheet/gi, 'timesheet')
    .replace(/ฮิวแมนซอฟ[ตท์]*|human\s*soft/gi, 'humansoft')
    .replace(/พจมาน|pojjaman|\bpjm\b/gi, 'pojjaman')
    .replace(/ลิงค์|ลิ้งก์|ลิ้งค์|\blink\b/gi, 'ลิงก์');
}

const HAS_TOPIC = /vpn|netbird|2sv|2-step|google workspace|dokploy|claude|kiro|outline|mcp|obsidian|wsl|docker|grab|เครื่องพิมพ์|พิมพ์ซอง|เน็ตเวิร์ก|ไวไฟ|timesheet|humansoft|pojjaman|builk\s*360|kwanjai|ขวัญใจ|\berp\b|bill\s*loader|วันลา|ลาป่วย|ลากิจ|พักร้อน|วันหยุด|กองทุน|ค่าน้ำมัน|ค่าเดินทาง|กีฬาสี|ห้องประชุม|ภาษี|ที่อยู่บริษัท|เบอร์บริษัท|plo[y]|พลอย|jubili|insite|อบรม|training|โน้ตบุ๊[คก]|ลาคลอด|ร้องทุกข์|ยกเลิกสัญญา|อยู่ทีมไหน|ขอ.*email/i;
const FOLLOW_UP = /^(?:ขอ|ช่วย|ย่อ|แล้ว|ทำ|ถ้า|บน|macos|windows|เพิ่ม|แก้|วิธี|ขั้นตอน|ลิงก์|เอกสาร|แบบฟอร์ม|อันนี้|อันนั้น|แปลว่า|หมายความ|งั้น|กลัว|ผมทำงาน|ฉันทำงาน|ชั่วโมงโครงการ|ซื้อ(?:ไป|มา|ก่อน|แล้ว)|จ่าย(?:เอง|ไป|ก่อน)|เบิก(?:ทีหลัง|คืน|ได้)|อนุมัติ(?:หลัง|ย้อนหลัง)|ยังไม่ได้อนุมัติ|buy\b|pay\b|reimburse\b)|^(?:pojjaman|humansoft|ระบบ\s*pojjaman|ระบบ\s*humansoft)(?:\s|ครับ|ค่ะ|$)/i;

/** Only short referential turns inherit user context. Assistant guesses never
 * become retrieval facts, and an explicit topic switch drops old context. */
export function retrievalQuery(question: string, history: readonly QueryTurn[] = []): string {
  const q = canonicalQuery(question);
  const systemOnly = /^(?:ใน\s*|ชั่วโมงโครงการ(?:ใน)?\s*)?(?:ระบบ\s*)?(pojjaman|humansoft)(?:\s*(?:ครับ|ค่ะ|คะ))?$/i;
  const systemAnswer = systemOnly.test(q.trim());
  const latestUser = history.filter(turn => turn.role === 'user').at(-1);
  const priorText = latestUser && canonicalQuery(latestUser.content).trim();
  // A repeated timesheet question can omit a system the user just confirmed.
  // Only reuse an immediately preceding Timesheet/system turn, never scan past
  // a topic switch or bind a system that appeared only in the bot's question.
  if (/timesheet/.test(q) && !/pojjaman|humansoft/.test(q) && priorText &&
      (systemOnly.test(priorText) || /timesheet/.test(priorText))) {
    const systems = new Set(priorText.match(/pojjaman|humansoft/g));
    if (systems.size === 1) return `${[...systems][0]}\n${q}`;
  }
  const frequency = /^(?:ได้|แจก|ให้|รับ)?(?:ทุกปี|ปีละครั้ง|ทุกเดือน)(?:ไหม|มั้ย|หรือเปล่า|ครับ|ค่ะ|คะ|\s|\?)*$/.test(q.trim());
  if ((!systemAnswer && (HAS_TOPIC.test(q) || queryConcepts(q).length > 0)) || q.length > 100 || !(systemAnswer || frequency || FOLLOW_UP.test(q.trim()))) return q;
  const previous = history.filter(m => m.role === 'user').slice(-4).map(m => canonicalQuery(m.content));
  const qualifiers: string[] = [];
  for (const t of previous.reverse()) {
    if (systemOnly.test(t.trim())) { qualifiers.unshift(t); continue; }
    if (HAS_TOPIC.test(t) || queryConcepts(t).length) return [t, ...qualifiers, q].join('\n');
    if (t.length > 100 || !FOLLOW_UP.test(t.trim())) break;
  }
  return q;
}

/** Keep retrieval context distinct from the current task. Otherwise a follow-up
 * such as "on Mac?" looks like two equally current requests to the answerer. */
export function answerQuery(question: string, history: readonly QueryTurn[] = []): string {
  const q = canonicalQuery(question);
  const contextual = retrievalQuery(question, history);
  if (contextual === q) return question;
  const prior = contextual.slice(0, -q.length).trim();
  return `บริบทหัวข้อจากคำถามก่อนหน้า (ใช้ระบุหัวข้อ ไม่ต้องตอบคำถามเดิมซ้ำ):\n${prior}\n\nคำถามล่าสุดที่ต้องตอบเท่านั้น:\n${question}`;
}

export function queryConcepts(text: string): string[] {
  const q = canonicalQuery(text);
  const concepts: [string, RegExp][] = [
    ['uniform', /เสื้อ(?:บริษัท|พนักงาน|โปโล)|ชุดพนักงาน|ยูนิฟอร์ม|เครื่องแบบพนักงาน/],
    ['overtime', /\bot\b|โอที|ล่วงเวลา/],
    ['meeting_room', /ห้องประชุม|ห้องสัมมนา|meeting room/],
    ['org_chart', /แผนผังองค์ก(?:ร|าร)|ผังองค์ก(?:ร|าร)|org(?:anization)? chart/],
    ['timesheet', /timesheet/], ['leave', /วันลา|การลา|สิทธิ์?ลา|แจ้งลา|ลา(?:อะไร|แบบไหน|ได้)|ลาป่วย|ลากิจ|ลาพัก|พักร้อน|พักผ่อน|ลาคลอด|คลอดบุตร|ลาบวช|ลาอุปสมบท|ลาเกณฑ์ทหาร|ลาอบรม|\bleave\b|maternity|vacation/],
    ['maternity', /ลาคลอด|คลอดบุตร|maternity/], ['annual_leave', /พักร้อน|พักผ่อน|annual leave|vacation/],
    ['sick_leave', /ลาป่วย|sick leave/], ['personal_leave', /ลากิจ|personal leave/],
    ['holiday', /วันหยุด|\bholidays?\b/], ['address', /ที่อยู่|เดินทางมาออฟฟิศ|\baddress\b/],
    ['provident', /กองทุน|provident/], ['travel', /ค่าเดินทาง|ค่าน้ำมัน/],
    ['training', /อบรม|training/], ['equipment', /โน้ตบุ๊[คก]|อุปกรณ์\s*it|laptop/],
    ['vpn', /vpn|netbird/], ['printer', /เครื่องพิมพ์|พิมพ์ซอง|printer|epson|kyocera|print\b/i],
    ['grievance', /ร้องทุกข์|ร้องเรียน|ถูกหัวหน้า.*ตำหนิ|หัวหน้า.*(?:พูดแรง|ด่า|ต่อว่า|ตำหนิ)/],
    ['workplace', /wfh|work from|ทำงาน.*(?:บ้าน|ต่างประเทศ)/],
    ['handover', /ยกเลิกสัญญา|ส่งมอบข้อมูล|ส่งข้อมูลออก|export.*data/i],
  ];
  return concepts.filter(([, re]) => re.test(q)).map(([name]) => name);
}
