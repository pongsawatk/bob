import type { SelectResult } from './select.js';
import { IT_COLLECTION_URL } from './it.js';

export const IT_NO_INFORMATION = `ยังไม่พบข้อมูลที่ยืนยันคำตอบนี้ใน IT Shared doc ครับ\n\n[เปิด IT Shared doc](${IT_COLLECTION_URL})`;
export const IT_UNAVAILABLE = `ขณะนี้ไม่สามารถดึงองค์ความรู้ IT ที่ยืนยันแหล่งที่มาได้ครับ กรุณาลองใหม่ หรือ[เปิด IT Shared doc](${IT_COLLECTION_URL})`;

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

/** Citation membership is enforced in code, independently of prompt compliance.
 * This verifies provenance, not semantic truth of every generated statement. */
export function validateITAnswer(raw: string, selected: SelectResult): { text: string; guarded: boolean } {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (value.noInformation === true) return { text: IT_NO_INFORMATION, guarded: false };
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
  } catch { return { text: IT_NO_INFORMATION, guarded: true }; }
}
