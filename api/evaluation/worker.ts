import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyQStash } from '../../src/analytics/queue.js';
import { processEvaluation } from '../../src/evaluation/jobs.js';

export const config = { maxDuration: 60 };
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  let body = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : '';
  if (!body) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const b = Buffer.from(chunk); size += b.length;
      if (size > 1024) { res.status(413).end(); return; }
      chunks.push(b);
    }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(body) > 1024) { res.status(413).end(); return; }
  const header = req.headers['upstash-signature'];
  const verified = await verifyQStash(typeof header === 'string' ? header : undefined, body);
  if (!verified.ok) { res.status(401).json({ error: 'Unauthorized' }); return; }
  let id: unknown;
  try { id = JSON.parse(body).jobId; } catch { /* invalid */ }
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) { res.status(400).end(); return; }
  try {
    const result = await processEvaluation(id);
    res.status(200).json({ id, status: result?.status ?? 'missing' });
  } catch { res.status(503).json({ error: 'Worker unavailable' }); }
}
