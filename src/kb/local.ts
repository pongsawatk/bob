// Phase 2 fallback: assemble bundles from the wiki markdown files shipped with
// the code. Used only when Outline + Redis are both unavailable, so BOB never
// goes mute. (This is the old Phase 1 loader, kept as a safety net.)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundles } from "./outline.js";

// process.cwd() = project root both locally and on Vercel (/var/task)
const root = join(process.cwd(), "knowledge-base", "wiki");

const SEP = "\n\n---\n\n";

function loadDomain(domain: keyof Bundles): string {
  const dir = join(root, domain);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return ""; // directory not present (e.g. product not seeded)
  }
  const parts = files.map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    return `## ${f.replace(".md", "")}\n${text}`;
  });
  return parts.join(SEP);
}

export function loadLocalBundles(): Bundles {
  return {
    hr: loadDomain("hr"),
    process: loadDomain("process"),
    product: loadDomain("product"),
  };
}
