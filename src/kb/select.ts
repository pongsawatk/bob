// Per-question KB retrieval: trim the large HR bundle down to the docs relevant
// to THIS question, instead of sending all ~48K chars every turn. This attacks the
// root cause of HR latency/cost (huge context) while staying robust:
//   • every doc participates by lexical score — a doc added to Outline later is
//     selected automatically, no mapping/router change (the "add KB later" concern)
//   • broad questions ("สวัสดิการมีอะไรบ้าง") or no lexical signal → return the FULL
//     bundle, so we never silently drop relevant content (catch-all)
//   • deterministic: same question → same subset → still cacheable
//
// Scoring is character n-gram overlap (no Thai word segmentation needed).

import { canonicalQuery, retrievalQuery, queryConcepts, type QueryTurn } from './query.js';
const SEP = "\n\n---\n\n";

// Tunables. Conservative on the first cut — prove quality holds (via run-eval),
// then lower the budget for more savings.
const BUDGET_CHARS = 18_000; // ~1/3 of the full HR bundle
const MIN_DOCS = 2;
const TITLE_WEIGHT = 3; // a hit in the title counts more than in the body

// Broad questions without a topic use the full bundle. Topic-specific lists
// retain relevant chapters and their explicit references.
// "ได้บ้าง" / "อะไรบ้าง" / "กี่ประเภท" are the common enumerate markers.
const BROAD = /อะไร\S{0,6}บ้าง|มีอะไร|ได้บ้าง|บ้างไหม|กี่ประเภท|ประเภท(ไหน|ใด|อะไร)|ทั้งหมด|ทุกอย่าง|ทุกประเภท|สรุป(ให้|มา|ทั้ง)?|รายการ|list|overview|ภาพรวม/i;

function norm(s: string): string {
  return canonicalQuery(s).replace(/[^฀-๿a-z0-9]/g, "");
}

function ngrams(s: string, n = 3): Set<string> {
  const t = norm(s);
  const set = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
  return set;
}

function overlap(q: Set<string>, doc: Set<string>): number {
  let c = 0;
  for (const g of q) if (doc.has(g)) c++;
  return c;
}

export interface SelectResult {
  bundle: string;
  selected: number;
  total: number;
  chars: number;
  fullChars: number;
  mode: "full" | "broad" | "retrieved";
  sources?: Array<{ title: string; url?: string }>;
  contextUsed?: boolean;
  referencedDocuments?: number;
  budgetExceeded?: boolean;
}

/** Pick the question-relevant subset of an assembled KB bundle (split on SEP). */
export function selectDocs(question: string, fullBundle: string, history: readonly QueryTurn[] = []): SelectResult {
  const blocks = fullBundle.split(SEP).filter(Boolean);
  const fullChars = fullBundle.length;
  const query = retrievalQuery(question, history);
  const sources = (bs: string[]) => bs.map(b => ({ title: b.split('\n')[0]!.replace(/^##\s*/, ''), url: /แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(b)?.[1] }));
  const base = { total: blocks.length, fullChars, contextUsed: query !== canonicalQuery(question) };

  // Already small, or an unscoped broad question → use everything.
  if (fullChars <= BUDGET_CHARS)
    return { bundle: fullBundle, selected: blocks.length, chars: fullChars, mode: "full", sources: sources(blocks), ...base };
  if (BROAD.test(question) && queryConcepts(query).length === 0)
    return { bundle: fullBundle, selected: blocks.length, chars: fullChars, mode: "broad", sources: sources(blocks), ...base };

  const qg = ngrams(query);
  const concepts = queryConcepts(query);
  const scored = blocks.map((b, i) => {
    const titleLine = b.split("\n", 1)[0] || "";
    // Explicit topic in a title outranks generic shared words such as สวัสดิการ.
    const topicHits = queryConcepts(titleLine).filter(c => concepts.includes(c)).length;
    const bodyHits = queryConcepts(b).filter(c => concepts.includes(c)).length;
    const score = 1000 * topicHits + 100 * bodyHits + overlap(qg, ngrams(b)) + TITLE_WEIGHT * overlap(qg, ngrams(titleLine));
    return { b, i, score, bodyHits, topicHits };
  });

  // No lexical signal at all → don't guess, send the full bundle (safe).
  if (scored.every((s) => s.score === 0))
    return { bundle: fullBundle, selected: blocks.length, chars: fullChars, mode: "full", sources: sources(blocks), ...base };

  // Highest score first (stable tie-break by original order).
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const picked: typeof scored = [];
  let chars = 0;
  for (const s of scored) {
    if (BROAD.test(question) && concepts.length && !s.bodyHits && !s.topicHits) continue;
    if (picked.length >= MIN_DOCS && chars + s.b.length > BUDGET_CHARS) continue;
    picked.push(s);
    chars += s.b.length;
  }
  // Follow explicit references, preserving entire documents and their exceptions.
  const initial = picked.length;
  const seen = new Set(picked.map(p => p.i));
  for (let depth = 0; depth < 2; depth++) {
    const bodies = picked.map(p => p.b.split('\n').slice(2).join('\n')).join('\n');
    const chapters = new Set([...bodies.matchAll(/(?:หมวด|บท)(?:ที่)?\s*(\d+)/g)].map(m => m[1]));
    const additions = scored.filter(s => !seen.has(s.i) && (
      [...s.b.split('\n')[0]!.matchAll(/(?:หมวด|บท)(?:ที่)?\s*(\d+)/g)].some(m => chapters.has(m[1])) ||
      (/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(s.b)?.[1] && bodies.includes(/แหล่งอ้างอิง:\s*(https?:\/\/\S+)/.exec(s.b)![1]!))
    ));
    if (!additions.length) break;
    for (const s of additions) { seen.add(s.i); picked.push(s); chars += s.b.length; }
  }
  // Restore document order for a stable, readable bundle (and stable cache key).
  picked.sort((a, b) => a.i - b.i);
  return {
    bundle: picked.map((p) => p.b).join(SEP),
    selected: picked.length,
    chars: picked.map(p => p.b).join(SEP).length,
    mode: BROAD.test(question) ? 'broad' : 'retrieved',
    referencedDocuments: picked.length - initial,
    budgetExceeded: chars > BUDGET_CHARS,
    sources: sources(picked.map(p => p.b)),
    ...base,
  };
}
