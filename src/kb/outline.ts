// Phase 2: Pull knowledge from Outline and assemble per-domain bundles.
// Two source modes, combinable:
//  • OUTLINE_COLLECTION_IDS ("BOB Knowledge Base"): top-level parent docs
//    (HR — …, Process — …, Product — …); every descendant is grouped under
//    the domain of its top-level ancestor.
//  • OUTLINE_HR_COLLECTION_IDS ("HR Shared", HR-owned): EVERY doc is HR-side.
//    Top-level docs are category containers (Benefits / Announcement / HR /
//    Policy / Process); "Process — …" maps to the process bundle, the rest to
//    hr. The category title is kept in each block header so retrieval
//    (kb/select.ts title scoring) and citations see it.
//    When HR collections are set, hr/process docs in OUTLINE_COLLECTION_IDS
//    are skipped — HR Shared becomes the single source of truth for HR.

import { env } from "../env.js";
import { fetchRetry } from "../http/fetchRetry.js";

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
  /** Relative document path from Outline, e.g. "/doc/hr-leave-x5Rxe7yk2k". */
  url?: string;
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
    const res = await fetchRetry(
      `${base}/api/documents.list`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OUTLINE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ collectionId, limit, offset }),
      },
      { retries: 2, timeoutMs: 15_000 }
    );
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

// PII guard: people-directory docs live in HR-owned collections but must NEVER
// enter the shared KB bundle (they'd ride into every user's prompt — see the
// personalization plan: directory is a separate lookup keyed by the asker's email).
const EXCLUDE_TITLES = /employee\s*directory|ทะเบียนพนักงาน/i;

const splitIds = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Fetch all configured collections and assemble HR/Process/Product bundles. */
export async function fetchOutlineBundles(): Promise<Bundles> {
  const generalIds = splitIds(env.OUTLINE_COLLECTION_IDS);
  const hrIds = splitIds(env.OUTLINE_HR_COLLECTION_IDS);
  if (!generalIds.length && !hrIds.length)
    throw new Error("OUTLINE_COLLECTION_IDS / OUTLINE_HR_COLLECTION_IDS are empty — set at least one collection id");

  const base = env.OUTLINE_BASE_URL.replace(/\/$/, "");
  // HR-side content comes exclusively from the HR collections when configured.
  const hrMode = hrIds.length > 0;

  const all: Array<OutlineDoc & { fromHrCollection: boolean }> = [];
  for (const id of generalIds)
    all.push(...(await fetchCollectionDocs(id)).map((d) => ({ ...d, fromHrCollection: false })));
  for (const id of hrIds)
    all.push(...(await fetchCollectionDocs(id)).map((d) => ({ ...d, fromHrCollection: true })));

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
    const top = topTitle(d);
    // Docs may contain "---" horizontal rules, which collide with SEP and would
    // shatter one doc into headerless pseudo-blocks (no title, no แหล่งอ้างอิง —
    // breaks countBlocks and per-question retrieval). Swap them for "***", the
    // equivalent markdown rule that can't collide.
    const body = (d.text ?? "").trim().replace(/\n\s*---+\s*\n/g, "\n\n***\n\n");

    let dom: keyof Bundles | null;
    let titleLine: string;
    if (d.fromHrCollection) {
      if (EXCLUDE_TITLES.test(d.title)) {
        console.warn(`KB: excluded "${d.title}" from bundle (people directory / PII guard)`);
        continue;
      }
      // Category containers themselves carry no content — skip empty bodies.
      if (!body) continue;
      dom = /^process\b/i.test(top) ? "process" : "hr";
      // Keep the category visible in the title line (helps select.ts title scoring
      // for questions like "สวัสดิการ…" and gives the model grouping context).
      titleLine = top !== d.title ? `## [${top}] ${d.title}` : `## ${d.title}`;
    } else {
      dom = domainOf(top);
      // HR Shared owns hr/process when configured — drop stale duplicates here.
      if (dom && dom !== "product" && hrMode) continue;
      titleLine = `## ${d.title}`;
    }
    if (!dom) continue;

    // Header carries the Outline source URL so the model can cite it (see prompt rule).
    const header = d.url ? `${titleLine}\nแหล่งอ้างอิง: ${base}${d.url}` : titleLine;
    parts[dom].push(body ? `${header}\n${body}` : header);
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
