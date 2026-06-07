// KB bundle composition — doc titles + sizes per domain, to design sub-buckets.
import { loadEnv } from "./_load-env.mjs";
loadEnv();
const { getHRBundle, getProductBundle } = await import("../src/kb/index.ts");
const SEP = "\n\n---\n\n";
function dump(name, bundle) {
  const blocks = bundle.split(SEP).filter(Boolean);
  const rows = blocks.map((b) => {
    const title = (b.split("\n")[0] || "").replace(/^##\s*/, "").slice(0, 55);
    return { title, chars: b.length };
  }).sort((a, b) => b.chars - a.chars);
  const total = rows.reduce((s, r) => s + r.chars, 0);
  console.log(`\n=== ${name} — ${blocks.length} docs, ${total} chars (~${Math.round(total/3.3)} tok) ===`);
  for (const r of rows) console.log(`  ${String(r.chars).padStart(6)}  ${r.title}`);
}
dump("HR bundle (hr+process)", await getHRBundle());
dump("PRODUCT bundle", await getProductBundle());
