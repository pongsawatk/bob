import { env } from '../env.js';
import { getRedis } from '../store/redis.js';
import { fetchCollectionDocs, type OutlineDoc } from './outline.js';

export const IT_COLLECTION_ID = 'd38c3f9c-8470-4bd7-8440-cc01c41e1b58';
export const IT_COLLECTION_URL = 'https://outline.builk.id/collection/it-shared-doc-8oeX9tBu9g/';
const VERSION = 1;
const KEY = `bob:kb:it:v${VERSION}:${IT_COLLECTION_ID}`;
export interface ITSnapshot {
  version: number;
  collectionId: string;
  baseUrl: string;
  refreshedAt: string;
  docs: Array<{ id: string; title: string; url: string; text: string }>;
}
export const itEnabled = () => env.OUTLINE_IT_COLLECTION_IDS.trim() === IT_COLLECTION_ID;

/** Independent source boundary. Never read the legacy bundles or local wiki. */
export function buildITSnapshot(docs: OutlineDoc[], now = new Date().toISOString()): ITSnapshot {
  const baseUrl = env.OUTLINE_BASE_URL.replace(/\/$/, '');
  const byId = new Map(docs.map(d => [d.id, d]));
  const rows: ITSnapshot['docs'] = [];
  for (const d of byId.values()) {
    if (d.collectionId !== IT_COLLECTION_ID) throw new Error('IT document belongs to an unapproved collection');
    if (!d.publishedAt || d.archivedAt || d.deletedAt || !d.text?.trim()) continue;
    if (/employee\s*directory|ทะเบียนพนักงาน/.test(d.title.toLowerCase())) continue;
    if (!d.url) throw new Error('IT document missing source URL');
    const url = new URL(d.url, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/doc/')) throw new Error('Invalid IT source URL');
    let parent = d; const seen = new Set([d.id]); const path = [d.title];
    while (parent.parentDocumentId && byId.has(parent.parentDocumentId) && !seen.has(parent.parentDocumentId)) {
      parent = byId.get(parent.parentDocumentId)!; seen.add(parent.id); path.unshift(parent.title);
    }
    rows.push({ id: d.id, title: path.join(' / '), url: url.href,
      text: d.text.trim().replace(/\n\s*---+\s*\n/g, '\n\n***\n\n') });
  }
  if (!rows.length) throw new Error('IT collection has no readable published content; previous snapshot retained');
  rows.sort((a, b) => a.title.localeCompare(b.title, 'th'));
  return { version: VERSION, collectionId: IT_COLLECTION_ID, baseUrl, refreshedAt: now, docs: rows };
}

export function validITSnapshot(value: unknown): value is ITSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as ITSnapshot;
  return s.version === VERSION && s.collectionId === IT_COLLECTION_ID &&
    s.baseUrl === env.OUTLINE_BASE_URL.replace(/\/$/, '') && Number.isFinite(Date.parse(s.refreshedAt)) &&
    Array.isArray(s.docs) && s.docs.length > 0 && s.docs.every(d => {
      if (!d || typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.text !== 'string' || !d.text.trim()) return false;
      try { const u = new URL(d.url); return u.origin === new URL(s.baseUrl).origin && u.pathname.startsWith('/doc/'); }
      catch { return false; }
    });
}

export async function prepareITSnapshot(): Promise<ITSnapshot> {
  if (!itEnabled()) throw new Error('OUTLINE_IT_COLLECTION_IDS must be the approved IT Shared doc ID');
  return buildITSnapshot(await fetchCollectionDocs(IT_COLLECTION_ID));
}

export async function writeITSnapshot(snapshot: ITSnapshot): Promise<void> {
  if (!validITSnapshot(snapshot)) throw new Error('Invalid IT snapshot');
  const r = getRedis(); if (!r) throw new Error('Redis is required for IT knowledge');
  // One atomic value contains content AND provenance. Failed refresh preserves the last good snapshot.
  await r.set(KEY, snapshot);
}

async function readITSnapshot(): Promise<unknown> {
  const r = getRedis(); return r ? r.get<unknown>(KEY) : null;
}

export async function getITBundle(read = readITSnapshot): Promise<string> {
  if (!itEnabled()) return '';
  try {
    const snapshot = await read();
    if (!validITSnapshot(snapshot)) return '';
    return snapshot.docs.map(d => `## ${d.title}\nแหล่งอ้างอิง: ${d.url}\n${d.text}`).join('\n\n---\n\n');
  } catch { console.error('IT knowledge cache unavailable'); return ''; }
}
