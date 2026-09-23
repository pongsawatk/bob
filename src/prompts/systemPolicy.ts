// Application behaviour, not company knowledge. Applied to remote AND fallback
// prompts so a stale production template cannot bypass these application rules.
export const SYSTEM_POLICY_VERSION = '2026-09-23.it1';
const ANSWER_POLICY = `ข้อกำหนดพฤติกรรมเพิ่มเติมของระบบ BOB (${SYSTEM_POLICY_VERSION}):
- ตอบทุกส่วนที่ผู้ใช้ขอ ถ้าข้อมูลไม่พอ ให้แยกส่วนที่ตอบได้กับส่วนที่ยังไม่มีหลักฐานอย่างชัดเจน
- คำถามสั้นว่า "สวัสดิการวันลา" หรือ "สิทธิ์วันลา" ให้สรุปประเภทวันลาและเงื่อนไขจากหมวดวันลาได้เลย คำว่า "วันลา" ชัดเจนพอ ไม่ต้องถามแยกกับวันหยุดนักขัตฤกษ์ เว้นแต่ผู้ใช้ถามทั้งสองเรื่องจริง ๆ
- แยกจำนวนวันที่ลาได้ออกจากจำนวนวันที่ได้รับค่าจ้างเสมอ อ่านรายละเอียดของหัวข้อนั้นประกอบตารางสรุป หากรายละเอียดระบุว่าลาได้เท่าที่ป่วยจริงแต่จำกัดค่าจ้าง ห้ามย่อเป็นลาป่วยได้ไม่เกินจำนวนวันจ่ายค่าจ้าง ถ้าเอกสารขัดแย้งกันจนสรุปไม่ได้ให้บอกจุดขัดแย้งและให้ HR ยืนยัน
- อย่าสรุปว่าผ่านทดลองงานหรือมีสิทธิ์แล้วจากวันเริ่มงานหรืออายุงานเพียงอย่างเดียว ข้อมูลทะเบียนปัจจุบันไม่มีสถานะยืนยันผ่านทดลองงาน ให้ใช้ถ้อยคำมีเงื่อนไขและให้ HR ยืนยัน
- Timesheet ของ Pojjaman กับเวลาเข้า–ออกงานใน HumanSoft เป็นคนละระบบ ถ้ายังไม่ชัดให้ถามก่อน ห้ามสรุปว่าการแก้ Timesheet คือการปลอมแปลงเวลาหรือผิดวินัย
- เมื่อข้อมูลไม่มี ให้บอกสิ่งที่ขาดและช่องทางเจ้าของข้อมูลเฉพาะที่มีในแหล่งอ้างอิง ห้ามเดาชื่อ เบอร์ ลิงก์ หรือขั้นตอน
- ตอบสั้นตรงงาน ไม่ทักแนะนำตัวซ้ำทุกครั้ง และอย่าเพิ่มคำชวนถามต่อเมื่อผู้ใช้ขอเพียงลิงก์หรือตัวเลข
- วันลาคงเหลือเป็นข้อมูลสดส่วนบุคคล ให้ชี้ทางตรวจ HumanSoft ไม่คำนวณยอดจากสิทธิ์วันลาประจำปี`;

export function applySystemPolicy(name: string, text: string): string {
  if (name === 'insight-analysis') text = text.replaceAll('HR|PRODUCT|GENERAL|PEOPLE|UNKNOWN', 'HR|PRODUCT|IT|GENERAL|PEOPLE|UNKNOWN');
  if (name === 'router') {
    text = text.replaceAll('HR|PRODUCT|GENERAL|PEOPLE|UNKNOWN', 'HR|PRODUCT|IT|GENERAL|PEOPLE|UNKNOWN').replaceAll('5 ตัวเลือก', '6 ตัวเลือก');
    if (!text.includes('- IT ')) text += '\n- IT = คู่มือการตั้งค่า/ใช้งาน/แก้ปัญหา IT เช่น VPN, Netbird, Google 2SV, Dokploy, AI Tools, Claude, Kiro, Outline MCP; สิทธิ์เบิกอุปกรณ์เป็น HR; บุคคลในทีม IT เป็น PEOPLE';
  }
  if (name === 'general') text = text.replace('เช่น แก้ปัญหา IT,', 'เช่น ลงมือแก้เครื่องให้,') + '\nBOB ตอบคู่มือ IT จาก IT Shared doc ได้แล้ว: VPN, Google 2SV, Outline MCP, Claude, Kiro โดยต้องส่งคำถามไปหมวด IT';
  if (name === 'people-intent') return `${text}\n\nเมื่อถามจำนวนแยกหลายกลุ่ม ให้ countOnly=true, subIntent=TEAM_ROSTER หรือ FOLLOW_UP_FILTER และเพิ่ม countGroups เป็น array ไม่เกิน 6 กลุ่ม แต่ละกลุ่มมี label และ team หรือ role ตามคำที่ผู้ใช้ขอเท่านั้น ห้ามเดากลุ่มที่ไม่ได้ถาม. searchParams เป็นขอบเขตรวม. ตัวอย่าง ทีม Pojjaman รวมกี่คน แยกทีม Dev/Business: searchParams={"team":"Pojjaman"}, countGroups=[{"label":"Dev","team":"Dev"},{"label":"Business","team":"Business"}]. อย่าแปลงทีม Business เป็นตำแหน่ง Business Analyst. คำแก้ไขชื่อให้ personRef เป็นชื่อใหม่ที่ผู้ใช้ระบุ โดยรักษาเจตนาการค้นหาคนเดิม.`;
  if (name === 'it') return `${text}\n\nกฎบังคับ: ใช้เฉพาะหลักฐานใน KB_BUNDLE ของ IT Shared doc เท่านั้น ห้ามใช้ประวัติคำตอบหรือความรู้ทั่วไปเติมขั้นตอน หากไม่มีหลักฐานตอบ JSON {"answer":"","sourceUrls":[],"noInformation":true}; หากมีหลักฐานตอบ JSON {"answer":"คำตอบ","sourceUrls":["URL จากแหล่งอ้างอิงใน KB_BUNDLE"],"noInformation":false} เท่านั้น ห้ามข้อความนอก JSON`;
  if (['hr', 'product', 'general'].includes(name)) return `${text}\n\n${ANSWER_POLICY}\nคู่มือการตั้งค่า/ใช้งาน/แก้ปัญหา IT ใช้หมวด IT จาก IT Shared doc เท่านั้น ห้ามเติมคำตอบ IT จากความรู้เดิม; HR ยังตอบสิทธิ์เบิกและสวัสดิการอุปกรณ์ได้`;
  if (name === 'router') return `${text}\n\nกฎแยกเจตนาเพิ่มเติม: Ploy/พลอย อาจเป็นผลิตภัณฑ์หรือชื่อคน คำว่าโปรแกรม/ระบบ/เบอร์กลาง/Support ของ Ploy ให้เป็น PRODUCT; ถ้ากำกวมให้ needs_clarification=true. Timesheet ที่ยังไม่ระบุ Pojjaman หรือ HumanSoft ต้องถามแยกระบบก่อน. คำถามที่อยู่และช่องทางบริษัทเป็นข้อมูลภายใน ให้ HR.`;
  return text;
}

/** Narrow deterministic backstop for the observed unsupported probation claim.
 * Preserve the useful procedure, replace only lines asserting confirmed status. */
export function guardEligibility(text: string): { text: string; guarded: boolean } {
  const claim = /(?:ผ่านทดลองงาน(?:มา)?แล้ว(?:แน่นอน)?|พ้น(?:ช่วง)?ทดลองงานแล้ว)/;
  const conditional = /ถ้า|หาก|เมื่อ|ต้อง|ยืนยัน|หรือยัง|ยังไม่|ไม่ได้|ไม่สามารถ/;
  let guarded = false;
  const lines = text.split('\n').map(line => {
    if (!claim.test(line) || conditional.test(line)) return line;
    guarded = true;
    return 'สิทธิ์นี้ต้องยืนยันว่าผ่านทดลองงานแล้วกับ HR ก่อนครับ อายุงานเพียงอย่างเดียวยังใช้ยืนยันสถานะนี้ไม่ได้';
  });
  return { text: lines.join('\n'), guarded };
}
