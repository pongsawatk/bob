#!/usr/bin/env node
// Build KB bundles by concatenating wiki/*.md per category
// Usage: node scripts/build-kb-bundle.mjs
// Output: dist/hr-bundle.md, dist/product-bundle.md, dist/all-bundle.md
//
// In n8n: replace <<HR_KB_BUNDLE>> in HR Bot prompt with content of dist/hr-bundle.md
// Bundle is the source of truth for what Bot can answer (cache_control: ephemeral on this block)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WIKI_DIR = path.join(REPO_ROOT, 'knowledge-base', 'wiki');
const OUT_DIR = path.join(REPO_ROOT, 'dist');

const SEPARATOR = '\n\n═══════════════════════════════════════════════════\n\n';

function readWikiFiles(subdir) {
  const dir = path.join(WIKI_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({
      filename: f,
      relpath: `wiki/${subdir}/${f}`,
      content: fs.readFileSync(path.join(dir, f), 'utf8')
    }));
}

function bundleFiles(files, label) {
  const header = `# BOB Knowledge Base — ${label}\n\n` +
    `> Built: ${new Date().toISOString()}\n` +
    `> Files: ${files.length}\n\n` +
    `---\n`;
  const body = files.map(f =>
    `<!-- FILE: ${f.relpath} -->\n${f.content}`
  ).join(SEPARATOR);
  return header + SEPARATOR + body + '\n';
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const hr = readWikiFiles('hr');
  const product = readWikiFiles('product');
  const process_ = readWikiFiles('process');

  // HR bundle = HR + Process (since HR Bot may need both)
  const hrBundle = bundleFiles([...hr, ...process_], 'HR + Process Knowledge');
  fs.writeFileSync(path.join(OUT_DIR, 'hr-bundle.md'), hrBundle);

  const productBundle = bundleFiles(product, 'Product Knowledge');
  fs.writeFileSync(path.join(OUT_DIR, 'product-bundle.md'), productBundle);

  const allBundle = bundleFiles([...hr, ...process_, ...product], 'All Knowledge');
  fs.writeFileSync(path.join(OUT_DIR, 'all-bundle.md'), allBundle);

  // Stats
  const hrChars = hrBundle.length;
  const productChars = productBundle.length;
  const allChars = allBundle.length;

  console.log('=== KB Bundle Build ===');
  console.log(`HR + Process bundle:  ${hr.length + process_.length} files, ${hrChars.toLocaleString()} chars (~${Math.round(hrChars / 3).toLocaleString()} tokens)`);
  console.log(`Product bundle:       ${product.length} files, ${productChars.toLocaleString()} chars (~${Math.round(productChars / 3).toLocaleString()} tokens)`);
  console.log(`All bundle:           ${hr.length + process_.length + product.length} files, ${allChars.toLocaleString()} chars (~${Math.round(allChars / 3).toLocaleString()} tokens)`);
  console.log(`\nOutput: dist/hr-bundle.md · dist/product-bundle.md · dist/all-bundle.md`);
  console.log(`\nNext: copy dist/hr-bundle.md content into n8n HR Bot system prompt at <<HR_KB_BUNDLE>>`);
  console.log(`      copy dist/product-bundle.md content into Product Bot at <<PRODUCT_KB_BUNDLE>>`);

  // Sanity check: cache_control 200K char limit
  if (hrChars > 800000) {
    console.warn(`\n⚠️  HR bundle exceeds 800K chars — split into separate caches or move T1 stable to wiki only`);
  }
}

main();
