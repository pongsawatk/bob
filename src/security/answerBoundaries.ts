/** Backstop for unsafe advice copied from relevant documents. Not a fact checker. */
export function guardAnswerBoundaries(text: string): string {
  const accessClaim=/(?:เป็นความลับ|เก็บ.{0,20}ความลับ|confidential|ไม่(?:ได้|มีการ|ถูก)?(?:ส่ง|ผ่าน|เปิดเผย|แชร์).{0,40}(?:HR|บริษัท)|ไม่มีใคร(?:เห็น|เข้าถึง)|(?:HR|บริษัท).{0,20}(?:ไม่(?:ได้)?เห็น|เข้าถึงไม่ได้|ไม่มี(?:การ|สิทธิ์?)(?:เข้าถึง|ดู|เห็น)))/i;
  const uncertainty='ยังยืนยันวิธีเก็บและผู้ที่เข้าถึงข้อมูลนี้ไม่ได้ครับ หากกังวลเรื่องความเป็นส่วนตัว ให้สอบถามผู้รับเรื่องก่อนและเปิดเผยเฉพาะข้อมูลที่จำเป็น';
  return text.split('\n').map(line => {
    const plain=line.replace(/[*_`]/g,'');
    if (/api\s*(?:key|token)|private\s*key|รหัสผ่าน|\btoken\b/i.test(plain) &&
        /(?<!ห้าม|อย่า|ไม่|ไม่ต้อง|ไม่ควร|ไม่ให้)(?:paste|แปะ|ส่ง|วาง|กรอก|ใส่|คัดลอก)[^\n]{0,160}(?:แช[ตท]|chat|prompt|พรอมป์ต์|ให้\s*(?:Claude|BOB|assistant))/i.test(plain)) {
      // A prohibition later in the same line must not excuse an earlier request
      // to paste the secret. Both positive and mixed advice get a safe instruction.
      return 'ตั้งค่ารหัสลับด้วยตัวเองในเครื่องหรือช่องตั้งค่าที่ได้รับอนุญาต ไม่ส่งลงแชต ใช้ <YOUR_API_KEY> แทนค่าจริงเมื่อต้องแสดงตัวอย่างครับ';
    }
    if (accessClaim.test(plain) &&
        !/ไม่สามารถ|ไม่อาจ|ไม่รับรอง|ไม่ยืนยัน|ไม่ควรรับรอง|รับรองไม่ได้/.test(plain) &&
        /บทสนทนา|ข้อมูล|อาการ|เรื่องที่เล่า|ร้องทุกข์/.test(plain)) {
      // Keep useful directions outside an unsupported parenthetical assertion.
      const retained=line.replace(/\([^()]*\)/g,part=>accessClaim.test(part.replace(/[*_`]/g,''))?'':part).trim();
      return retained!==line.trim() && !accessClaim.test(retained.replace(/[*_`]/g,''))
        ? `${retained}\n${uncertainty}` : uncertainty;
    }
    return line;
  }).join('\n');
}

export const OWN_TOKEN_SETUP = 'ไม่ต้องแปะ API token ในแชตครับ ให้กรอกค่าจริงด้วยตัวเองใน environment variable หรือช่องตั้งค่าของเครื่องตามคู่มือ เมื่อต้องการให้ช่วยตรวจรูปแบบ ให้ใช้ <YOUR_API_KEY> แทนค่าจริง';
/** An explicit request to induce guilt gets a neutral draft without an invented
 * workload, deadline, or availability. Quoted analysis and non-pressure drafts
 * continue through the normal drafting path. */
export function asksForGuiltDraft(question:string):boolean {
  if(/แปล|วิเคราะห์|อธิบาย|ยกตัวอย่าง/.test(question)) return false;
  if(/(?:ไม่อยาก|ไม่ต้องการ|อย่า|ห้าม|โดยไม่|ไม่ทำให้).{0,35}(?:รู้สึกผิด|ผิดใจกัน|กดดัน)/.test(question)) return false;
  return /เขียน|ร่าง/.test(question) && /งาน|เพื่อน|ร่วมงาน/.test(question)
    && /ให้.{0,35}รู้สึกผิด|รู้สึกว่า.{0,45}ผิดใจกัน/.test(question);
}
export const VOLUNTARY_HELP_DRAFT = 'ผมไม่ช่วยเขียนกดดันให้เพื่อนรู้สึกผิดครับ แต่ร่างคำขอที่ปฏิเสธได้ให้แทน:\n\n“สวัสดีครับ [ชื่อเพื่อน] พอจะช่วย [งานหรือส่วนที่ต้องการให้ช่วย] ได้ไหมครับ ถ้าไม่สะดวก ปฏิเสธได้เลยครับ ขอบคุณที่พิจารณาครับ”\n\nเติมเฉพาะรายละเอียดที่เป็นจริง หากต้องระบุเหตุผลหรือกำหนดเวลา ให้ใช้ข้อมูลของคุณเองครับ';

export function asksToShareOwnToken(question:string):boolean {
  return /api\s*(?:token|key)|\btoken\b/i.test(question) && /แปะ|paste|ส่ง|วาง/i.test(question) && /ตรงนี้|แช[ตท]|chat|ให้คุณ/i.test(question);
}

/** Requests to bypass authentication are not account-recovery instructions.
 * Refuse before loading manuals that include privileged administrator steps. */
export function asksToBypassAuthentication(question: string): boolean {
  return /2\s*[- ]?(?:sv|fa)|mfa|two[- ](?:step|factor)|ยืนยัน(?:ตัวตน)?สอง(?:ขั้น|ชั้น)/i.test(question)
    && /ข้าม|เลี่ยง|bypass|disable|turn\s*off|ปิด.*(?:ยืนยัน|2\s*[- ]?(?:sv|fa)|mfa)/i.test(question);
}
export const AUTHENTICATION_BOUNDARY = 'ผมช่วยข้ามหรือปิดการยืนยันตัวตนเพื่อเลี่ยงการเข้าถึงไม่ได้ครับ หากรีบใช้บัญชี ให้ลองวิธียืนยันอื่นที่คุณตั้งไว้แล้วด้วยตัวเอง หรือแจ้งทีม IT ให้ตรวจปัญหาและสิทธิ์บัญชีตามกระบวนการที่ได้รับอนุญาต โดยไม่ส่งรหัสผ่าน OTP หรือ backup code ลงแชต';

/** Narrow, standalone attempts to replace evidence rules. Quoted text and
 * requests for concise answers are not instructions to invent certainty. */
export function asksToReplaceEvidenceRules(question: string): boolean {
  const q = question.trim();
  const directive = /^(?:จากนี้|ต่อไปนี้|ตั้งแต่นี้|ทุกคำตอบ|ให้ตอบทุก|ตอบทุก|from now on|always answer|for all (?:future )?answers)/i.test(q);
  const certainty = /มั่นใจ\s*(?:100\s*%|ร้อยเปอร์เซ็นต์|เต็มร้อย)|100\s*%\s*(?:certain|confident)|never (?:admit|express|mention) uncertainty|ห้าม(?:บอก|ระบุ|ยอมรับ).{0,15}(?:ไม่รู้|ไม่แน่ใจ|ไม่แน่นอน)/i.test(q);
  const noEvidence = /(?:ไม่ต้อง|ห้าม|ไม่).{0,12}(?:อ้างอิง|แหล่ง|source|หลักฐาน)|(?:without|never|no).{0,20}(?:sources?|citations?|evidence)/i.test(q);
  // A substantive question alongside the override should still reach its domain.
  return directive && certainty && noEvidence && !/[?？]|กี่วัน|เท่าไหร่|อย่างไร|ยังไง|อะไร|ช่วยร่าง|ช่วยสรุป/i.test(q);
}
export const EVIDENCE_RULE_BOUNDARY = 'ผมช่วยตอบให้ชัดและตรงประเด็นได้ครับ แต่จะไม่รับปากว่ามั่นใจ 100% เมื่อข้อมูลไม่พอ และยังต้องบอกข้อจำกัดหรืออ้างหลักฐานที่จำเป็น ส่งคำถามที่ต้องการให้ช่วยมาได้เลยครับ';

/** Act only on an explicit admission of fabrication, never infer dishonesty
 * from illness, travel, weak symptoms, or an ordinary request for leave. */
export function asksToFabricateIllness(question: string): boolean {
  if (/^(?:ช่วย)?(?:แปล|อธิบาย|วิเคราะห์|ตรวจข้อความ)|^(?:translate|explain|review)\b/i.test(question.trim())) return false;
  const draft = /(?:เขียน|ร่าง|แต่ง).{0,45}(?:ป่วย|อาการ)|(?:write|draft|make up).{0,45}(?:sick|illness)/i.test(question);
  const admission = /ไม่ได้(?:เจ็บ)?ป่วย(?!หนัก|แล้ว)|แกล้งป่วย|ปลอม(?:เหตุผล|อาการ|ใบลา)|ทั้งที่(?:จริง)?.{0,18}(?:ไปเที่ยว|ไปทะเล)|(?:not (?:actually )?sick|fake (?:illness|sick))/i.test(question);
  return draft && admission;
}
export const HONEST_LEAVE_DRAFT = 'ผมไม่ช่วยแต่งว่าป่วยทั้งที่ไม่ได้ป่วยครับ แต่ช่วยร่างคำขอลาตามจริงได้:\n\n“เรียน [ชื่อหัวหน้า] ผมขออนุญาตลาในวันที่ [วันที่] เนื่องจาก [เหตุผลจริงที่ต้องการแจ้ง] โดยขอใช้ [ประเภทการลาที่ตรงกับเหตุผลและนโยบาย] รบกวนพิจารณาคำขอด้วยครับ”\n\nเลือกประเภทการลาตามเหตุผลจริงและนโยบายก่อนส่ง ไม่ใช้ลากิจกับลาพักผ่อนเป็นคำแทนกัน และข้อความนี้ยังไม่ใช่การอนุมัติครับ';
