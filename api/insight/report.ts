// WP-12 slice 6 — serves a stored /insight report behind a signed, expiring link.
// The deliver stage's summary card points its "เปิดรายงาน" button here. Inert unless
// INSIGHT_ENABLED=1; requires a valid HMAC token; 404s once the report's TTL expires.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getRedis } from "../../src/store/redis.js";
import { insightEnabled } from "../../src/analytics/queue.js";
import { verifyReportToken, reportRedisKey } from "../../src/analytics/reportLink.js";

export const config = { maxDuration: 10 };

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!insightEnabled()) { res.status(404).send("disabled"); return; }
  const jobId = String(req.query.jobId ?? "");
  const token = String(req.query.token ?? "");
  if (!verifyReportToken(jobId, token)) { res.status(401).send("unauthorized"); return; }

  const r = getRedis();
  const report = r ? await r.get<string>(reportRedisKey(jobId)) : null;
  if (!report) { res.status(404).send("report not found or expired"); return; }

  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>BOB Insight</title></head>` +
    `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.5">` +
    `<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,monospace;font-size:14px">${escapeHtml(report)}</pre>` +
    `</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(html);
}
