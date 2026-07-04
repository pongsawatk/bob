// Phase 2 KB orchestrator. Read path (per request): in-memory → Redis → local
// files. Refresh path (manual /refresh): Outline → Redis → in-memory.
//
// The request path never touches Outline: refreshes are explicit so a cold
// start can't trigger a slow 36-doc fetch on a user's first message.

import { fetchOutlineBundles, countBlocks, type Bundles } from "./outline.js";
import { readBundlesFromRedis, writeBundlesToRedis, type KbMeta } from "./cache.js";
import { loadLocalBundles } from "./local.js";

// Short in-memory TTL: each warm instance re-reads Redis at most once/minute, so
// an admin /refresh propagates to all instances within ~60s without re-fetching
// Redis on every single message.
const MEM_TTL_MS = 60_000;

let mem: { bundles: Bundles; at: number; source: "redis" | "local" | "outline" } | null = null;

const SEP = "\n\n---\n\n";
const empty = (domain: string) =>
  `[${domain} knowledge base — ยังไม่มีเนื้อหา กรุณาเพิ่มข้อมูลใน Outline]`;

async function getBundles(): Promise<Bundles> {
  if (mem && Date.now() - mem.at < MEM_TTL_MS) return mem.bundles;

  try {
    const fromRedis = await readBundlesFromRedis();
    if (fromRedis) {
      mem = { bundles: fromRedis, at: Date.now(), source: "redis" };
      return fromRedis;
    }
  } catch (err) {
    console.error("KB: Redis read failed, falling back to local files:", err);
  }

  const local = loadLocalBundles();
  mem = { bundles: local, at: Date.now(), source: "local" };
  return local;
}

export async function getHRBundle(): Promise<string> {
  const b = await getBundles();
  const combined = [b.hr, b.process].filter(Boolean).join(SEP);
  return combined || empty("hr");
}

export async function getProductBundle(): Promise<string> {
  const b = await getBundles();
  return b.product || empty("product");
}

export interface RefreshResult {
  refreshedAt: string;
  counts: KbMeta["counts"];
}

/** Pull from Outline, store in Redis, and warm this instance's memory. */
export async function refreshKB(): Promise<RefreshResult> {
  const bundles = await fetchOutlineBundles();
  const counts = {
    hr: countBlocks(bundles.hr),
    process: countBlocks(bundles.process),
    product: countBlocks(bundles.product),
  };

  // Never overwrite a good KB with an empty one. A silent-empty fetch happens
  // when the Outline API token can't see a configured collection (Outline
  // filters inaccessible docs instead of erroring) — incident 2026-07-05:
  // /refresh wiped the HR bundle because the prod token had no HR Shared access.
  if (counts.hr + counts.process === 0 || counts.product === 0) {
    throw new Error(
      `refreshKB: got empty bundle (hr=${counts.hr}, process=${counts.process}, product=${counts.product}) — ` +
        `refusing to overwrite. Check that OUTLINE_API_TOKEN can read every collection in ` +
        `OUTLINE_COLLECTION_IDS / OUTLINE_HR_COLLECTION_IDS.`
    );
  }

  const meta: KbMeta = { refreshedAt: new Date().toISOString(), counts };

  await writeBundlesToRedis(bundles, meta);
  mem = { bundles, at: Date.now(), source: "outline" };
  return { refreshedAt: meta.refreshedAt, counts };
}

/** For tests/scripts: drop the in-memory cache. */
export function clearMemCache(): void {
  mem = null;
}
