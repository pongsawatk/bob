// Read-only Langfuse export. Usage: node --import tsx scripts/export-analytics.mjs --from ISO --to ISO --out test-results/snapshot.json
import { loadEnv } from './_load-env.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
loadEnv();
const { fetchTraces, normalizeAll, aggregate } = await import('../src/analytics/langfuse.ts');
const { snapshotTurns, snapshotKeyId, qualityCounts } = await import('../src/analytics/snapshot.ts');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const fromMs = Date.parse(arg('--from') ?? ''), toMs = Date.parse(arg('--to') ?? '');
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs || !arg('--out')) throw new Error('Provide --from ISO --to ISO (exclusive) --out path');
const creds = { host: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com', publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY };
if (!creds.publicKey || !creds.secretKey) throw new Error('Langfuse credentials missing');
const key = process.env.ANALYTICS_PSEUDONYM_KEY || creds.secretKey;
// Optional historical local trace export preserves evidence before API retention removes it.
const raws = arg('--input') ? JSON.parse(await readFile(arg('--input'), 'utf8')) : await fetchTraces(creds, { fromMs, toMs });
if (!Array.isArray(raws)) throw new Error('Local input must be a trace array');
const turns = normalizeAll(raws).filter(t => t.tsMs >= fromMs && t.tsMs < toMs);
const report = aggregate(turns, { fromMs, toMs });
const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(),
  pseudonymKeyId: snapshotKeyId(key), source: arg('--input') ? 'local_trace_export' : 'langfuse_observations',
  requestedWindow: report.window,
  coverage: { firstObserved: turns.length ? new Date(Math.min(...turns.map(t => t.tsMs))).toISOString() : null,
    lastObserved: turns.length ? new Date(Math.max(...turns.map(t => t.tsMs))).toISOString() : null,
    note: 'Observed bounds do not prove full coverage. API retention may omit older activity; preserve overlapping exports and deduplicate by id.' },
  report, quality: qualityCounts(turns), turns: snapshotTurns(turns, key),
};
const output = resolve(arg('--out'));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, turns: turns.length, uniqueUsers: report.uniqueUsers, quality: payload.quality }));
