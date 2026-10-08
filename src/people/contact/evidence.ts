import registry from './registry.json';
import { getHRBundle, getProductBundle } from '../../kb/index.js';
import { getITBundle } from '../../kb/it.js';
import type { ProfileMap } from '../profileStore.js';
import { norm } from '../profileStore.js';
import { resolveTeamScope } from '../retrieval/aliases.js';

export interface ContactEvidence {
  topic: string;
  sourceUrl: string;
  quote: string;
  team?: string;
  personEmail?: string;
  sharedEmail?: string;
}
interface ContactRecord extends ContactEvidence { aliases: string[]; verifiedAt: string }
const compact=(s:string)=>norm(s).replace(/[\s*_`]/g,'');
const safeUrl=(s:string)=>{try{return new URL(s).protocol==='https:';}catch{return false;}};

/** Exact source quotations only. No responsibility is inferred from someone's title. */
export function contactEvidence(topic: string, bundle: string, directory: ProfileMap, now=Date.now(), records: ContactRecord[]=registry): ContactEvidence[] {
  const t=compact(topic);
  if(t.length<2)return [];
  const approved=records.filter(r=>[r.topic,...r.aliases].some(a=>compact(a)===t) && safeUrl(r.sourceUrl) && Number.isFinite(Date.parse(r.verifiedAt)) && now-Date.parse(r.verifiedAt)>=0 && now-Date.parse(r.verifiedAt)<180*86400000);
  if(approved.length)return approved.filter(r=>!r.personEmail||!!directory[r.personEmail]);
  const found:ContactEvidence[]=[];
  for(const block of bundle.split('\n\n---\n\n')){
    const lines=block.split('\n');
    // Title must identify the requested subject; incidental mentions are not ownership evidence.
    if(!compact(lines[0]??'').includes(t))continue;
    const url=/แหล่งอ้างอิง:\s*(https:\/\/\S+)/.exec(block)?.[1];if(!url||!safeUrl(url))continue;
    for(const raw of lines){
      const line=raw.replace(/[*_`]/g,'').trim();
      if(!/ติดต่อ|สอบถาม.*(?:ทีม|ฝ่าย)|contact/i.test(line)||line.length>400)continue;
      if(/ห้าม|ไม่ต้อง|ไม่ควร|อย่า|ยกเลิก|เลิกใช้|do not|don't|no longer/i.test(line))continue;
      const person=Object.values(directory).filter(p=>[p.fullNameTh,p.fullNameEn].some(n=>n&&n.length>5&&line.includes(n)));
      if(person.length===1){found.push({topic,sourceUrl:url,quote:line,personEmail:person[0]!.email});continue;}
      const team=/(?:ติดต่อ|สอบถาม)(?:ได้ที่|ทาง|กับ|ทีม|ฝ่าย|\s)*(HR|IT|ฝ่ายทรัพยากรบุคคล|Human Resources|IT Support)(?:\b|\s|$)/i.exec(line)?.[1];
      if(team){const term=/hr|บุคคล|human/i.test(team)?'HR':'IT';if(resolveTeamScope(directory,term).status==='resolved')found.push({topic,sourceUrl:url,quote:line,team:term});}
    }
  }
  return [...new Map(found.map(e=>[e.sourceUrl+'|'+(e.personEmail||e.team),e])).values()].slice(0,3);
}
export async function loadContactEvidence(topic:string,directory:ProfileMap):Promise<ContactEvidence[]>{
  const bundles=await Promise.all([getHRBundle(),getProductBundle(),getITBundle()]);
  return contactEvidence(topic,bundles.join('\n\n---\n\n'),directory);
}
