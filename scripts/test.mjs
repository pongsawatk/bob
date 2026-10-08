import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Node 20 on Windows does not expand quoted test globs; pass explicit paths.
const files = readdirSync('test').filter(f => f.endsWith('.test.ts')).sort().map(f => `test/${f}`);
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
if (r.error) console.error(r.error.message);
process.exitCode = r.status ?? 1;
