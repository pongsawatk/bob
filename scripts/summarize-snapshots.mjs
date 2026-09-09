// Usage: node --import tsx scripts/summarize-snapshots.mjs --from ISO --to ISO snapshot1.json snapshot2.json
import { readFile } from 'node:fs/promises';
const { aggregate } = await import('../src/analytics/langfuse.ts');
const { mergeSnapshots, qualityCounts } = await import('../src/analytics/snapshot.ts');
const args = process.argv.slice(2), files = []; let fromMs = NaN, toMs = NaN;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--from') fromMs = Date.parse(args[++i]);
  else if (args[i] === '--to') toMs = Date.parse(args[++i]);
  else files.push(args[i]);
}
if (!files.length || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new Error('Provide --from ISO --to ISO and snapshot paths');
const snapshots = await Promise.all(files.map(async f => JSON.parse(await readFile(f, 'utf8'))));
const turns = mergeSnapshots(snapshots).filter(t => t.tsMs >= fromMs && t.tsMs < toMs);
console.log(JSON.stringify({ sources: files.length, report: aggregate(turns.map(t => ({ ...t, rawUserId: t.userKey })), { fromMs, toMs }), quality: qualityCounts(turns), note: 'Combines observed turns only; exports do not establish that the requested window has complete coverage.' }, null, 2));
