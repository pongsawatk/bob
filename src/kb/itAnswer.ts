import type { SelectResult } from './select.js';
import { IT_COLLECTION_URL } from './it.js';

export const IT_NO_INFORMATION = `ยังไม่พบข้อมูลที่ยืนยันคำตอบนี้ใน IT Shared doc ครับ\n\n[เปิด IT Shared doc](${IT_COLLECTION_URL})`;
export const IT_UNAVAILABLE = `ขณะนี้ไม่สามารถดึงองค์ความรู้ IT ที่ยืนยันแหล่งที่มาได้ครับ กรุณาลองใหม่ หรือ[เปิด IT Shared doc](${IT_COLLECTION_URL})`;

const linksIn = (text: string): string[] => text.match(/https?:\/\/[^\s<>\])"}`]+/g) ?? [];
const canonicalUrl = (url: string) => new URL(url.replace(/[.,;!]+$/, '')).href;

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
    const operationalUrls = new Set(citedBlocks.flatMap(linksIn).map(canonicalUrl));
    if (linksIn(value.answer).some(u => !operationalUrls.has(canonicalUrl(u)))) throw new Error('Unsupported answer link');
    const citations = urls.map(u => `[${allowed.get(u)!.replace(/[\[\]]/g, '')}](${u})`).join('\n');
    return { text: `${value.answer.trim()}\n\nแหล่งอ้างอิง:\n${citations}`, guarded: false };
  } catch { return { text: IT_NO_INFORMATION, guarded: true }; }
}
