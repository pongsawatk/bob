// Phase 1: Load KB from local wiki markdown files.
// Phase 2 will replace this with Outline API + Redis cache.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge-base", "wiki");

type Domain = "hr" | "product" | "process";

// Module-level cache — avoids re-reading files on warm invocations
const bundles = new Map<Domain, string>();

function loadDomain(domain: Domain): string {
  if (bundles.has(domain)) return bundles.get(domain)!;

  const dir = join(root, domain);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    // Directory not found (e.g. product wiki not seeded yet)
    const empty = `[${domain} knowledge base — ยังไม่มีเนื้อหา กรุณาเพิ่มข้อมูลใน Outline]`;
    bundles.set(domain, empty);
    return empty;
  }

  const parts = files.map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    return `## ${f.replace(".md", "")}\n${text}`;
  });

  const bundle = parts.join("\n\n---\n\n");
  bundles.set(domain, bundle);
  return bundle;
}

export function getHRBundle(): string {
  // hr/ + process/ combined for HR bot
  const hr = loadDomain("hr");
  const process = loadDomain("process");
  return [hr, process].filter(Boolean).join("\n\n---\n\n");
}

export function getProductBundle(): string {
  return loadDomain("product");
}

/** For testing: wipe cached bundles */
export function clearBundleCache(): void {
  bundles.clear();
}
