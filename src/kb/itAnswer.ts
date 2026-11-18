import type { SelectResult } from './select.js';
import { IT_COLLECTION_URL } from './it.js';

export const IT_NO_INFORMATION = `ยังไม่พบข้อมูลที่ยืนยันคำตอบนี้ใน IT Shared doc ครับ บอกงานที่กำลังทำ ระบบปฏิบัติการ หรือข้อความบนหน้าจอเพิ่มได้ โดยไม่ส่งรหัสผ่านหรือ token ผมจะช่วยหาคู่มือที่ตรงเรื่องและเตรียมข้อมูลให้ทีม IT ตรวจต่อ\n\n[เปิด IT Shared doc](${IT_COLLECTION_URL})`;
export const IT_UNAVAILABLE = `ขณะนี้ไม่สามารถดึงองค์ความรู้ IT ที่ยืนยันแหล่งที่มาได้ครับ กรุณาลองใหม่ หรือ[เปิด IT Shared doc](${IT_COLLECTION_URL})`;
export const IT_REFUSED = 'ผมไม่ให้รหัสผ่าน private key หรือข้อมูลลับของบัญชีผู้ดูแลระบบครับ หากต้องใช้สิทธิ์ทำงาน กรุณาติดต่อทีม IT เพื่อขอสิทธิ์หรือช่องทางที่ได้รับอนุญาต โดยไม่ส่งรหัสลับมาในแชต';
export function itMissingEvidence(query: string): string {
  const platform = /mac(?:os)?|แมค/i.test(query) ? 'Mac/macOS' : /windows|วินโดวส์/i.test(query) ? 'Windows' : '';
  return platform
    ? `ยังไม่พบคู่มือที่รองรับขั้นตอนที่ถามสำหรับ ${platform} ในเอกสารที่เลือกครับ ผมจึงไม่ใช้ขั้นตอนของระบบอื่นแทน กรุณาแจ้งทีม IT ว่าใช้ ${platform} พร้อมสิ่งที่ต้องการทำและข้อความผิดพลาดถ้ามี เพื่อให้ตรวจขั้นตอนที่เหมาะสม\n\n[เปิด IT Shared doc](${IT_COLLECTION_URL})`
    : IT_NO_INFORMATION;
}
export function asksForCredential(query: string): boolean {
  return /ขอ|บอก|แสดง|ส่ง|เปิดเผย|give|show/i.test(query) && /private\s*key|รหัสผ่าน.*(?:admin|administrator|บัญชี|ระบบ)|(?:admin|administrator).*password|secret\s*key/i.test(query);
}

function linksIn(text: string, strict = false): string[] {
  const absolute = /https?:\/\/[^\s<>\])"}`]+/gi;
  const urls: string[] = text.match(absolute) ?? [];
  // Bare domains are clickable in clients too. Do not let omitting https://
  // bypass provenance checks (including phishing lookalikes in login steps).
  const bare = /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>\])"}`]*)?/gi;
  urls.push(...(text.replace(absolute, ' ').match(bare) ?? []));
  if (strict) {
    const destinations = [...text.matchAll(/\]\(\s*<?([^\s)>]+)/g), ...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm)];
    for (const match of destinations) {
      const target = match[1]!;
      if (!/^https?:\/\//i.test(target) && !new RegExp(`^(?:${bare.source})$`, 'i').test(target)) throw new Error('Unsupported link format');
    }
  }
  return urls;
}
const canonicalUrl = (url: string) => new URL((/^https?:\/\//i.test(url) ? '' : 'https://') + url.replace(/[.,;!]+$/, '')).href;

/** An explicit first navigation instruction can be rendered without asking a
 * model to combine it with the following login/install actions. */
export function firstNavigation(selected:SelectResult,query:string):string|undefined {
  if(!/ขอแค่ขั้นแรก|ขั้นแรกก่อน/.test(query)||!/vpn|netbird/i.test(query)||/mac|แมค/i.test(query)) return;
  const candidates=selected.bundle.split('\n\n---\n\n').filter(b=>/vpn|netbird/i.test(b.split('\n')[0]??''));
  for(const b of candidates) {
    const first=/ลำดับแรกให้เข้าไปที่เว็บไซต์\s*\n+\s*<(https?:\/\/[^>\s]+)>/.exec(b);
    const ref=/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(b)?.[1];
    if(first&&ref) return `ขั้นแรก เปิดเว็บไซต์ ${first[1]} ครับ\n\nอ้างอิง: ${ref}`;
  }
}

/** Citation membership is enforced in code, independently of prompt compliance.
 * This verifies provenance, not semantic truth of every generated statement. */
export function validateITAnswer(raw: string, selected: SelectResult, query = ''): { text: string; guarded: boolean; status?: 'refused' | 'no_information' } {
  try {
    // Accept one JSON object surrounded by prose/fences, but never display that
    // prose. Greedy boundaries deliberately reject multiple competing objects.
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Missing answer object');
    const value = JSON.parse(raw.slice(start, end + 1));
    if (value.status === 'refused') return { text: IT_REFUSED, guarded: false, status:'refused' };
    if (value.noInformation === true) return { text: itMissingEvidence(query), guarded: false, status:'no_information' };
    const allowed = new Map((selected.sources ?? []).filter(s => s.url).map(s => [s.url!, s.title]));
    if (typeof value.answer !== 'string' || !value.answer.trim() || !Array.isArray(value.sourceUrls) || !value.sourceUrls.length ||
      value.sourceUrls.some((u: unknown) => typeof u !== 'string' || !allowed.has(u))) throw new Error('Unsupported citation');
    const urls = [...new Set<string>(value.sourceUrls)];
    // A procedure can contain operational URLs (VPN server, download, MCP).
    // They must occur in the CITED document, not merely share its hostname.
    const citedBlocks = selected.bundle.split('\n\n---\n\n').filter(b =>
      urls.includes(/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(b)?.[1] ?? ''));
    const operationalUrls = new Set(citedBlocks.flatMap(b => linksIn(b)).map(canonicalUrl));
    if (linksIn(value.answer, true).some(u => !operationalUrls.has(canonicalUrl(u)))) throw new Error('Unsupported answer link');
    const citations = urls.map(u => `[${allowed.get(u)!.replace(/[\[\]]/g, '')}](${u})`).join('\n');
    return { text: `${value.answer.trim()}\n\nแหล่งอ้างอิง:\n${citations}`, guarded: false };
  } catch { return { text: itMissingEvidence(query), guarded: true }; }
}
