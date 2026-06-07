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

const SEP = "\n\n---\n\n";

// Tunables. Conservative on the first cut — prove quality holds (via run-eval),
// then lower the budget for more savings.
const BUDGET_CHARS = 18_000; // ~1/3 of the full HR bundle
const MIN_DOCS = 6; // always keep at least this many top docs
const TITLE_WEIGHT = 3; // a hit in the title counts more than in the body

// Broad/enumerate questions need many docs across topics — send the full bundle
// rather than risk dropping one (e.g. "ฉันลาอะไรได้บ้าง" must list every leave type).
// "ได้บ้าง" / "อะไรบ้าง" / "กี่ประเภท" are the common enumerate markers.
const BROAD = /อะไร\S{0,6}บ้าง|มีอะไร|ได้บ้าง|บ้างไหม|กี่ประเภท|ประเภท(ไหน|ใด|อะไร)|ทั้งหมด|ทุกอย่าง|ทุกประเภท|สรุป(ให้|มา|ทั้ง)?|รายการ|list|overview|ภาพรวม/i;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^฀-๿a-z0-9]/g, "");
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
}

/** Pick the question-relevant subset of an assembled KB bundle (split on SEP). */
export function selectDocs(question: string, fullBundle: string): SelectResult {
  const blocks = fullBundle.split(SEP).filter(Boolean);
  const fullChars = fullBundle.length;
  const base = { total: blocks.length, fullChars };

  // Already small, or a broad/list question → use everything.
  if (fullChars <= BUDGET_CHARS)
    return { bundle: fullBundle, selected: blocks.length, chars: fullChars, mode: "full", ...base };
  if (BROAD.test(question))
    return { bundle: fullBundle, selected: blocks.length, chars: fullChars, mode: "broad", ...base };

  const qg = ngrams(question);
  const scored = blocks.map((b, i) => {
    const titleLine = b.split("\n", 1)[0] || "";
    const score = overlap(qg, ngrams(b)) + TITLE_WEIGHT * overlap(qg, ngrams(titleLine));
    return { b, i, score };
  });

  // No lexical signal at all → don't guess, send the full bundle (safe).
  if (scored.every((s) => s.score === 0))
    return { bundle: fullBundle, selected: blocks.length, chars: fullChars, mode: "full", ...base };

  // Highest score first (stable tie-break by original order).
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const picked: typeof scored = [];
  let chars = 0;
  for (const s of scored) {
    if (picked.length >= MIN_DOCS && chars + s.b.length > BUDGET_CHARS) continue;
    picked.push(s);
    chars += s.b.length;
  }
  // Restore document order for a stable, readable bundle (and stable cache key).
  picked.sort((a, b) => a.i - b.i);
  return {
    bundle: picked.map((p) => p.b).join(SEP),
    selected: picked.length,
    chars,
    mode: "retrieved",
    ...base,
  };
}
