import {retrievalQuery,queryConcepts,type QueryTurn} from './query.js';

/** Narrow, fact-free backstop: never convert a policy ceiling to a personal
 * payment calendar. Numerical policy facts remain in the source-grounded answer. */
export function guardLeavePay(text: string, question: string, kb: string, history: readonly QueryTurn[]=[]): {text:string;guarded:boolean} {
  const topics=queryConcepts(retrievalQuery(question,history));
  let guarded=false;
  const blocks=kb.split('\n\n---\n\n');
  const sourceFor=(heading:string)=>blocks.find(b=>b.includes(`### ${heading}\n`));
  const section=(block:string,heading:string)=>block.split(`### ${heading}\n`)[1]?.split(/\n#{1,3} /)[0]??'';
  const urlFor=(block:string)=>/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(block)?.[1];
  const bullet=(line:string)=>line.replace(/^\s*- \[ \]\s*/, '- ');
  // An overview can contain the same maternity inference even though the user's
  // query only says "leave benefits". Keep that bullet tied to its source too.
  const maternityBlock=sourceFor('ลาคลอดบุตร');
  const maternityLine=maternityBlock && section(maternityBlock,'ลาคลอดบุตร').split('\n').find(l=>/บริษัท.*จ่ายค่าจ้าง/.test(l));
  if (maternityLine && maternityBlock) text=text.split('\n').map(line=>{
    if (/ลาคลอด/.test(line) && /ประกันสังคม/.test(line) && /ส่วนที่เหลือ|ส่วนเกิน|ช่วงหลัง|แทน/.test(line)) {
      guarded=true;
      return `- **ลาคลอดบุตร:** ${maternityLine.replace(/^\s*- \[ \]\s*/,'')}\nอ้างอิง: ${urlFor(maternityBlock)??''}`;
    }
    return line;
  }).join('\n');
  const annualBlock=blocks.find(b=>/สิทธิ์ลาพักผ่อนประจำปีแบ่งตามอายุงาน/.test(b));
  const annualUrl=annualBlock && urlFor(annualBlock);
  if (annualBlock && annualUrl && /พักผ่อน|พักร้อน/.test(text)) {
    const condition=annualBlock.split('\n').find(l=>/นับตั้งแต่วันเริ่มทดลองงาน/.test(l));
    if (condition && !/นับ.*(?:เริ่มทดลองงาน|เริ่มงาน)/.test(text)) text+=`\n\n${condition}`;
    if (!text.includes(annualUrl)) text+=`\nอ้างอิงสิทธิพักผ่อน: ${annualUrl}`;
  }
  // Payment questions need a bounded, source-derived answer. Pattern removal
  // alone cannot reliably catch every paraphrase of invented payment calendars.
  if (topics.includes('maternity') && /เงิน|จ่าย|ค่าจ้าง/.test(question)) {
    const block=sourceFor('ลาคลอดบุตร');
    const policy=block && section(block,'ลาคลอดบุตร').split('\n').find(l=>/บริษัท.*จ่ายค่าจ้าง/.test(l));
    const url=block && urlFor(block);
    if (policy && url) {
      text=`สิทธิวันลากับค่าจ้างบริษัทเป็นคนละจำนวนครับ ตามเอกสาร:\n${bullet(policy)}\n\nจึงไม่ควรตีความว่าได้รับค่าจ้างเต็มตลอดการลา ข้อมูลนี้เป็นค่าจ้างจากบริษัทเท่านั้น เอกสารระบุเพดานจำนวนวันที่บริษัทจ่าย แต่ไม่ได้กำหนดช่วงวันจ่ายเฉพาะคนหรือรับรองยอดเงินรวมทุกสิทธิ หากต้องการคำนวณยอดจริง ให้ HR ยืนยันข้อมูลของคุณก่อนครับ\nอ้างอิง: ${url}`;
      guarded=true;
    }
  }
  if (topics.includes('sick_leave') && /(?:ต่อเนื่อง|ติดต่อกัน).*\d+\s*วัน|\d+\s*วัน.*(?:ต่อเนื่อง|ติดต่อกัน)/.test(question)) {
    const block=sourceFor('ลาป่วย');
    const lines=block ? section(block,'ลาป่วย').split('\n').filter(l=>/ลาป่วยได้เท่าที่ป่วยจริง|ใบรับรองแพทย์|แจ้งผู้บังคับบัญชา/.test(l)) : undefined;
    const url=block && urlFor(block);
    if (lines?.some(l=>/ได้รับค่าจ้าง/.test(l)) && url) {
      text=`${/กลัว|กังวล/.test(question)?'เข้าใจว่ากังวลเรื่องการลาครับ ':''}ตามเอกสารมีหลักเกณฑ์ดังนี้:\n${lines.map(bullet).join('\n')}\n\nยังคำนวณจำนวนวันที่ได้รับหรือไม่ได้รับค่าจ้างของคุณไม่ได้ ต้องยืนยันปี หน่วยวัน และยอดสิทธิค่าจ้างที่ใช้ไปก่อน โดยตรวจ HumanSoft หรือให้ HR ยืนยัน\nหากกังวลเรื่องแจ้งหัวหน้า คุณอาจแจ้งอาการเท่าที่จำเป็น แนบเอกสารตามเกณฑ์ และคุยเรื่องส่งต่องานระหว่างพัก โดยไม่ต้องรับรองว่าจะทำงานระหว่างป่วยครับ\nอ้างอิง: ${url}`;
      guarded=true;
    }
  }
  if (topics.includes('sick_leave') || topics.includes('maternity')) {
    const lines=text.split('\n').map(line=>{
      const plain=line.replace(/[*_`]/g,'');
      const calendar=/(?:\d+\s*วันแรก|วันที่\s*\d+\s*[–—-]\s*\d+|(?:ส่วนเกิน|ที่เหลือ)\s*\d+\s*วัน|\d+\s*วันที่เหลือ|คือ\s*\d+\s*วัน)/.test(plain);
      const replaceSSO=topics.includes('maternity') && /(?:ช่วงที่ไม่ได้รับค่าจ้าง|ส่วนที่เหลือ|ช่วงหลัง).*(?:ประกันสังคม|แทน)/.test(plain);
      if ((calendar && /ค่าจ้าง|เงิน|จ่าย/.test(plain)) || replaceSSO) {
        guarded=true;
        const maternityPolicy=kb.split('\n').find(l=>/บริษัท.*จ่ายค่าจ้าง/.test(l)&&/คลอด|วัน\/ครั้ง/.test(l));
        return topics.includes('maternity')
          ? `${maternityPolicy?'เอกสารระบุ: '+maternityPolicy.replace(/^- \[ \] /,'')+'\n':''}เอกสารไม่ได้ระบุช่วงวันจ่ายค่าจ้างเฉพาะคน ส่วนประกันสังคมเป็นสิทธิแยกตามเงื่อนไข ไม่ใช่เงินแทนเฉพาะช่วงหลังบริษัทหยุดจ่ายครับ`
          : 'ยังยืนยันวันที่ได้รับหรือไม่ได้รับค่าจ้างของคุณไม่ได้ครับ ต้องทราบปี หน่วยวัน และยอดสิทธิค่าจ้างที่ใช้ไปก่อน โดยตรวจจาก HumanSoft หรือให้ HR ยืนยัน';
      }
      return line;
    });
    text=[...new Set(lines)].join('\n');
  }
  // Detect this conflict from the actual served document, not a hardcoded quota.
  if (topics.includes('sick_leave') || /สวัสดิการวันลา|วันลา.*(?:อะไรบ้าง|กี่ประเภท)|ประเภท(?:การ)?ลา/.test(retrievalQuery(question,history))) {
    const block=kb.split('\n\n---\n\n').find(b=>/ลาป่วยได้เท่าที่ป่วยจริง/.test(b) && /\|[^\n]*ลาป่วย[^\n]*\|/.test(b));
    if (block && !/ตาราง[\s\S]{0,180}(?:รายละเอียด|ต่าง|ขัด)/.test(text)) {
      const row=block.split('\n').find(l=>/\|[^\n]*ลาป่วย/.test(l));
      const quota=row?.match(/(?:≤|ไม่เกิน)\s*(\d+)\s*วัน\/ปี/)?.[1];
      const url=/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(block)?.[1];
      if (quota && url) text+=`\n\nข้อสังเกตจากเอกสาร: ตารางสรุปเขียนลาป่วย ≤ ${quota} วัน/ปี แต่รายละเอียดระบุลาได้เท่าที่ป่วยจริงและจำกัดค่าจ้าง จึงควรให้ HR ยืนยันถ้อยคำสองส่วนนี้ก่อนใช้ตัดสินสิทธิเฉพาะกรณี\nอ้างอิง: ${url}`;
    }
  }
  return {text,guarded};
}
