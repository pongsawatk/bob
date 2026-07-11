// WP-12 slice 6 — signed report link (pure).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
process.env.CRON_SECRET ??= "test-secret";
process.env.INSIGHT_WORKER_URL = "https://bob.example.com/api/insight/worker";
const { signReportToken, verifyReportToken, reportUrl, reportRedisKey } = await import("../src/analytics/reportLink.ts");

test("sign/verify roundtrip", () => {
  const tok = signReportToken("job-1");
  assert.equal(verifyReportToken("job-1", tok), true);
});

test("tampered token or wrong jobId fails", () => {
  const tok = signReportToken("job-1");
  assert.equal(verifyReportToken("job-2", tok), false); // token bound to job-1
  assert.equal(verifyReportToken("job-1", tok.slice(0, -1) + "0"), false); // flipped char
  assert.equal(verifyReportToken("job-1", ""), false);
  assert.equal(verifyReportToken("", tok), false);
});

test("reportUrl derives the report endpoint from the worker URL + carries a valid token", () => {
  const url = reportUrl("job-1")!;
  assert.match(url, /^https:\/\/bob\.example\.com\/api\/insight\/report\?jobId=job-1&token=/);
  const token = new URL(url).searchParams.get("token")!;
  assert.equal(verifyReportToken("job-1", token), true);
});

test("reportRedisKey is stable + matches the worker's stored key", () => {
  assert.equal(reportRedisKey("job-1"), "bob:insight:job:job-1:state:report");
});
