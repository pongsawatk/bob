import {retrievalQuery, type QueryTurn} from './query.js';

const url=(block:string)=>/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(block)?.[1];
const plain=(text:string)=>text.replace(/\*\*/g,'').replace(/- \[ \]/g,'-').trim();
const section=(text:string,title:string)=>{
  const lines=text.split('\n'),index=lines.findIndex(l=>/^#{2,3} /.test(l)&&l.includes(title));
  return index<0 ? undefined : lines.slice(index+1).join('\n').split(/\n(?:\*\*\*|## )/)[0]?.trim();
};

/** Source excerpts keep actors, units, and clock triggers together. Only use
 * recognized document sections; a missing or changed source stays with normal
 * evidence handling rather than supplying a memorized company rule. */
export function roomAvailabilityAnswer(question: string, kb: string): string | undefined {
  if (/^(?:(?:วันนี้|พรุ่งนี้|วันที่\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*)?(?:มี)?ห้องประชุม(?:ไหน|ใด)?ว่าง(?:อยู่)?(?:บ้าง|ไหม|มั้ย|ครับ|ค่ะ|คะ|\s|[?？])*$/.test(question.trim())) {
    const booking = kb.split('\n\n---\n\n').find(b => url(b) && b.split('\n').some(line =>
      /(?:จอง|booking).{0,40}outlook/i.test(line) && !/ห้าม|ยกเลิก|ไม่(?:ได้|ใช้|ต้อง)/.test(line)) && /ห้องประชุม/.test(b));
    return 'BOB ตรวจสถานะห้องว่างแบบสดไม่ได้ครับ' +
      (booking ? ` กรุณาตรวจตารางห้องประชุมใน Outlook ตามคู่มือการจอง\nอ้างอิง: ${url(booking)}` :
        ' กรุณาตรวจตารางจองห้องประชุมสำหรับวันที่และเวลาที่ต้องการครับ');
  }
}

export function policyEvidenceAnswer(question:string,kb:string,history:readonly QueryTurn[]=[]):string|undefined {
  const q=retrievalQuery(question,history);
  const blocks=kb.split('\n\n---\n\n');
  if(/โน้ตบุ๊ก|โน้ตบุ๊ค|อุปกรณ์/.test(q) && /ย้อนหลัง|ซื้อไปก่อน|จ่ายเองไปแล้ว|ซื้อไปแล้ว/.test(question)) {
    const b=blocks.find(b=>/สวัสดิการ/.test(b)&&/ผู้บังคับบัญชาต้นสังกัดสูงสุด/.test(b)&&/พนักงานจ่ายก่อน/.test(b)&&/L1 = IT, L2 = CFO/.test(b));
    const steps=b&&section(b,'📋 ขั้นตอนการขออนุมัติ');
    const payment=b?.split('\n').find(l=>l.includes('**กรณีที่ 1**')&&l.includes('พนักงานจ่ายก่อน'));
    if(b&&url(b)&&steps&&payment) return `การจ่ายเงินก่อนแล้วเบิกคืน กับการซื้อก่อนขออนุมัติเป็นคนละเรื่องครับ คู่มือรองรับกรณีนี้:\n${plain(payment)}\n\nขั้นตอนที่เอกสารกำหนด:\n${plain(steps)}\n\nIT เป็นผู้อนุมัติ L1 ตอนเบิก จึงไม่แทนอีเมลอนุมัติล่วงหน้าจากผู้บังคับบัญชาครับ เอกสารที่เลือกไม่ได้ระบุขั้นตอนอนุมัติย้อนหลัง จึงยังยืนยันไม่ได้ว่ากรณีซื้อไปแล้วจะได้รับอนุมัติหรือไม่ หากซื้อแล้ว อาจสอบถาม HR/IT พร้อมเล่าขั้นตอนที่ทำจริง เพื่อให้ยืนยันกรณีของคุณ โดยไม่ถือว่าข้อแนะนำนี้เป็นการอนุมัติหรือขั้นตอนย้อนหลังที่บริษัทรับรอง\nอ้างอิง: ${url(b)}`;
  }
  if(/อบรม/.test(q) && /เริ่ม|ขั้นตอน|อนุมัติ/.test(question) && !/ร่าง|ไม่อนุมัติ|ถูกปฏิเสธ|ค่าใช้จ่าย|ต่างประเทศ/.test(question)) {
    const b=blocks.find(b=>/External Training/.test(b)&&/ผู้บังคับบัญชาต้นสังกัดลงนามอนุมัติ/.test(b));
    if(b&&url(b)) {
      const steps=section(b,'📋 ขั้นตอนการขออนุมัติ');
      const conditions=section(b,'เงื่อนไขการลาเพื่อฝึกอบรม');
      if(steps&&conditions) return `ตามคู่มือการฝึกอบรมภายนอก:\n\n${plain(steps)}\n\n${plain(conditions)}\n\nบทบาท HR ในขั้นตอนข้างต้นคือส่งแบบฟอร์มและรับเอกสาร ส่วนผู้ลงนามอนุมัติคือผู้บังคับบัญชาต้นสังกัดครับ\nอ้างอิง: ${url(b)}`;
    }
  }
  if(/ร้องทุกข์/.test(q) && /หัวหน้า|ผู้บังคับบัญชา/.test(question) && /ช่องทาง|ร้องตรง|ยื่นตรง|ร่าง/.test(question) && !/อุทธรณ์|ขั้นที่\s*[23]|ไม่พอใจผล/.test(question)) {
    const b=blocks.find(b=>/ขั้นตอนการร้องทุกข์/.test(b)&&/กรณีข้อร้องทุกข์เกี่ยวข้องกับผู้บังคับบัญชาโดยตรง/.test(b));
    const exception=b?.split('\n').find(l=>l.includes('กรณีข้อร้องทุกข์เกี่ยวข้องกับผู้บังคับบัญชาโดยตรง'));
    if(b&&url(b)&&exception) return `หากเรื่องร้องทุกข์เกี่ยวข้องกับหัวหน้าโดยตรง ใช้ช่องทางตามข้อยกเว้นนี้ได้ครับ:\n${plain(exception)}\n\nเอกสารระบุกำหนดแจ้งผลของ HR ไว้ในขั้นที่ 2 แต่ไม่ได้ระบุชัดว่ากำหนดนั้นใช้กับการยื่นตรงตามข้อยกเว้นนี้อย่างไร จึงควรให้ HR ยืนยันกำหนดตอบรับและแจ้งผลของกรณีนี้ครับ\n${/ร่าง/.test(question)?'\nตัวอย่างข้อความ (เติมเฉพาะข้อเท็จจริงที่เกิดขึ้น):\nเรียน HR ผมขอปรึกษาเรื่องการสื่อสารกับผู้บังคับบัญชา เหตุการณ์คือ [วันและสิ่งที่เกิดขึ้น] ส่งผลต่อผมคือ [ผลกระทบที่เกิดขึ้นจริง] อยากขอคำแนะนำเรื่องช่องทางและแนวทางดำเนินการที่เหมาะสมครับ\n':''}\nอ้างอิง: ${url(b)}`;
  }
}

export function guardTrainingUnit(text:string,kb:string):string {
  const training=kb.split('\n').findIndex(l=>/^### ลาเพื่อฝึกอบรม/.test(l));
  const excerpt=training>=0 ? kb.split('\n').slice(training+1).join('\n').split(/\n### /)[0]??'' : '';
  const source=excerpt.split('\n').find(l=>/\d+\s*วันทำงาน/.test(l))??kb.split('\n').find(l=>/สิทธิ์ลา/.test(l)&&/\d+\s*วันทำงาน/.test(l));
  const days=source?.match(/(\d+)\s*วันทำงาน/)?.[1];
  if(!days) return text;
  return text.split('\n').map(l=>/อบรม|พัฒนาความรู้/.test(l) ? l.replace(new RegExp(`(${days}\\s*)วัน(?!ทำงาน)`,'g'),'$1วันทำงาน') : l).join('\n');
}
