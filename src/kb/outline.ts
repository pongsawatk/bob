// Phase 2: Pull knowledge from Outline and assemble per-domain bundles.
// The "BOB Knowledge Base" collection holds top-level parent docs
// (HR — …, Process — …, Product — …); every descendant is grouped under
// the domain of its top-level ancestor.

import { env } from "../env.js";

export interface Bundles {
  hr: string;
  process: string;
  product: string;
}

interface OutlineDoc {
  id: string;
  title: string;
  text: string;
  parentDocumentId: string | null;
}

// Top-level parent title prefix → domain
const DOMAIN_BY_PREFIX: Array<[RegExp, keyof Bundles]> = [
  [/^hr\b/i, "hr"],
  [/^process\b/i, "process"],
  [/^product\b/i, "product"],
];

const SEP = "\n\n---\n\n";

async function fetchCollectionDocs(collectionId: string): Promise<OutlineDoc[]> {
  const base = env.OUTLINE_BASE_URL.replace(/\/$/, "");
  const out: OutlineDoc[] = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const res = await fetch(`${base}/api/documents.list`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OUTLINE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ collectionId, limit, offset }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Outline documents.list HTTP ${res.status}: ${body}`);
    }
    const json = (await res.json()) as { data?: OutlineDoc[] };
    const batch = json.data ?? [];
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

/** Fetch all configured collections and assemble HR/Process/Product bundles. */
export async function fetchOutlineBundles(): Promise<Bundles> {
  const ids = env.OUTLINE_COLLECTION_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error("OUTLINE_COLLECTION_IDS is empty — set it to the BOB KB collection id");

  const all: OutlineDoc[] = [];
  for (const id of ids) all.push(...(await fetchCollectionDocs(id)));

  const byId = new Map(all.map((d) => [d.id, d]));

  // Walk up to the top-level ancestor (guard against cycles).
  const topTitle = (d: OutlineDoc): string => {
    let cur = d;
    const seen = new Set<string>();
    while (cur.parentDocumentId && byId.has(cur.parentDocumentId) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentDocumentId)!;
    }
    return cur.title;
  };

  const domainOf = (title: string): keyof Bundles | null => {
    for (const [re, dom] of DOMAIN_BY_PREFIX) if (re.test(title)) return dom;
    return null;
  };

  const parts: Record<keyof Bundles, string[]> = { hr: [], process: [], product: [] };

  // Stable, deterministic order so the assembled bundle (and its cache key) is reproducible.
  all.sort((a, b) => a.title.localeCompare(b.title, "th"));

  for (const d of all) {
    const dom = domainOf(topTitle(d));
    if (!dom) continue;
    const body = (d.text ?? "").trim();
    parts[dom].push(body ? `## ${d.title}\n${body}` : `## ${d.title}`);
  }

  return {
    hr: parts.hr.join(SEP),
    process: parts.process.join(SEP),
    product: parts.product.join(SEP),
  };
}

/** Number of doc blocks in a bundle (for refresh summaries). */
export function countBlocks(bundle: string): number {
  if (!bundle) return 0;
  return bundle.split(SEP).length;
}
