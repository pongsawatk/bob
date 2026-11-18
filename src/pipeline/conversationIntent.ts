import type { QueryTurn } from '../kb/query.js';

/** Only the immediately preceding user topic can be edited. Assistant prose is
 * never an authority for the recipient or facts. Reset/trim naturally drops it. */
export function draftSource(message: string, history: readonly QueryTurn[]): string | undefined {
  if (/ร่าง|draft|ช่วยขอให้/i.test(message)) return message;
  if (!/^(?:ขอ|เอา|ปรับ|ช่วยปรับ|ย่อ|ให้|ทำให้).{0,45}(?:สั้น|ประโยค|สุภาพ|เป็นทางการ|เป็นกันเอง|น้ำเสียง)/.test(message.trim())) return;
  for (let i=history.length-1;i>=0;i--) {
    const t=history[i]!;
    if(t.role!=='user') continue;
    if (/ร่าง|draft|ช่วยขอให้/i.test(t.content)) return t.content;
    if (!/^(?:ขอ|เอา|ปรับ|ช่วยปรับ|ย่อ|ให้|ทำให้).{0,45}(?:สั้น|ประโยค|สุภาพ|เป็นทางการ|เป็นกันเอง|น้ำเสียง)/.test(t.content.trim())) return;
  }
}

export function generalBoundary(message: string, history: readonly QueryTurn[]): string | undefined {
  if (!history.some(t=>t.role==='user') && /^(?:ทำยังไงดี|ทำอย่างไรดี|ช่วยหน่อย)(?:ครับ|ค่ะ|คะ|นะ|\s|[?!])*$/u.test(message.trim()))
    return 'หมายถึงเรื่องไหนครับ?';
  if (/^(?:เหนื่อยมากเลย[ ,]*|วันนี้เหนื่อย[ ,]*)?(?:แต่)?(?:ยัง)?(?:ไม่อยาก(?:เล่า|คุย)เรื่องงาน|ขอพักเรื่องงาน)(?:ก่อน|ครับ|ค่ะ|คะ|นะ|\s|[.!])*$/u.test(message.trim()))
    return 'พักเรื่องงานไว้ก่อนได้ครับ อยากคุยเรื่องอื่นหรือแค่อยู่เงียบ ๆ สักพักก็ได้';
}

/** Workload drafts use source spans, not free-form assertions. The model selects
 * exact user clauses; the renderer owns connective prose and cannot promise a
 * deadline, invent a reason, or attach a task type to another quantity. */
export function workloadDraftSource(message: string, history: readonly QueryTurn[]): string | undefined {
  const source=draftSource(message,history);
  if(source && /\d/.test(source) && /งาน/.test(source) && /ทำได้|รับได้|ไหว/.test(source)) return source;
  if(source && /(?:ให้เพื่อน|เพื่อนช่วย)/.test(source) && /งาน|รายงาน|เอกสาร/.test(source)
    && !/รู้สึกผิด|ผิดใจกัน|บังคับ|จนยอม|กดดัน/.test(source.replace(/ไม่กดดัน/g,''))) return source;
}

export const WORKLOAD_DRAFT_SCHEMA = `Return only JSON {"requestQuote":"exact contiguous user words naming the requested task, or empty", "factQuotes":["exact contiguous user clauses for workload AND capacity"], "recipient":"peer or manager"}.
Select spans ONLY from DRAFT_SOURCE below. Do not rewrite words, add task types, reasons, dates, promises, or numbers. Each factQuote must be a complete factual clause including its subject and qualifiers. If no workload/capacity facts were given, factQuotes must be []. Preserve every number and its relation to the user's work. Do not quote instructions to BOB as facts. recipient=manager only if the user explicitly addresses a manager. requestQuote must name the task, not a reason or the instruction to ask another person. No Markdown.`;

/** These are request prefixes, not task facts. Remove them before the renderer
 * adds its own request, so the peer is asked to do the task rather than relay it. */
function taskQuote(quote:string):string {
  return quote.replace(/^(?:ช่วย)?(?:ขอ)?ให้(?:เพื่อน|เขา|คุณ)(?:ช่วย)?|^ช่วย/u,'').trim();
}

/** A generic meeting request contains no availability, reason, or duration.
 * The caller must still resolve and display the recipient from the directory. */
export function managerMeetingDraft(source:string|undefined,message:string):string|undefined {
  if(!source || !/หัวหน้า(?:ของ)?(?:ผม|ฉัน|ดิฉัน|เรา)/.test(source) || !/ขอเวลาคุยเรื่องงาน(?:หน่อย|ครับ|ค่ะ|คะ|นะ|\s|[?!])*$/u.test(source)) return;
  if(/ไม่(?:ต้อง|อยาก)?(?:ขอเวลา|คุย)|ห้าม|อย่า|ยกเลิก/.test(source)) return;
  return /ไม่เป็นทางการ|เป็นกันเอง/.test(message)
    ? 'ขอเวลาคุยเรื่องงานหน่อยได้ไหมครับ สะดวกช่วงไหนบอกได้เลยนะครับ'
    : 'สวัสดีครับ ขอเวลาคุยเรื่องงานหน่อยได้ไหมครับ รบกวนแจ้งช่วงเวลาที่สะดวกด้วยครับ';
}

export function renderWorkloadDraft(raw:string,source:string,message:string): {text:string;valid:boolean} {
  try {
    const v=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
    if(!Array.isArray(v.factQuotes)||v.factQuotes.length>6) throw Error();
    const facts=v.factQuotes as unknown[];
    if(facts.some(f=>typeof f!=='string'||f.length<3||!source.includes(f)||/ช่วยร่าง|ช่วยเขียน/.test(f))) throw Error();
    const starts=(facts as string[]).map(f=>source.indexOf(f));
    const start=starts.length?Math.min(...starts):0,end=starts.length?Math.max(...(facts as string[]).map((f,i)=>starts[i]!+f.length)):0;
    if(start>0&&!/[\s,;:，。]/.test(source[start-1]!)) throw Error();
    const joined=source.slice(start,end);
    // Counts must survive verbatim; no arbitrary replacement number is allowed.
    if((source.match(/\d+/g)??[]).some(n=>!joined.includes(n))) throw Error();
    if(/ทำได้|รับได้|ไหว/.test(source)&&!/ทำได้|รับได้|ไหว/.test(joined)) throw Error();
    const request=typeof v.requestQuote==='string' && v.requestQuote && source.includes(v.requestQuote) ? taskQuote(v.requestQuote)||'[งานที่อยากขอให้ช่วย]' : '[งานที่อยากขอให้ช่วย]';
    const manager=/หัวหน้า/.test(source);
    const informal=/ไม่เป็นทางการ|เป็นกันเอง/.test(message);
    const body=manager
      ? 'รบกวนช่วยเลือกงานที่ควรทำก่อน และตกลงว่าจะจัดการงานที่เหลืออย่างไรได้ไหมครับ'
      : `พอจะช่วย${request}ได้ไหมครับ ถ้าไม่สะดวกปฏิเสธได้เลยครับ`;
    return {text:`${informal?'':'สวัสดีครับ '}${manager?'[ชื่อหัวหน้า]':'[ชื่อเพื่อน]'}\n${joined?joined+'\n':''}${body}`,valid:true};
  } catch {
    return {text:'ร่างเบื้องต้นครับ:\n[ชื่อผู้รับ] ขอคุยเพื่อจัดลำดับงานและตกลงเรื่องความช่วยเหลือได้ไหมครับ\n[ใส่จำนวนงานและกำลังที่ทำได้ตามข้อความเดิม]\nหากไม่สะดวกช่วย แจ้งได้เลยครับ',valid:false};
  }
}
