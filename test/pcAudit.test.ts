// WP-22.4 — audit log (no sensitive text) + feedback aggregate.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { createAuditLog } = await import("../src/people/audit/log.ts");
const { createFeedbackStore } = await import("../src/people/audit/feedback.ts");

test("audit records only the four allowlisted fields — no query text leaks in", () => {
  const log = createAuditLog();
  // caller accidentally passes queryText — it must be dropped.
  const evt = log.record({ subIntent: "OWNER_LOOKUP", policyOutcome: "REFUSE", resultCount: 0, timestamp: 1000, queryText: "เงินเดือนของสมชาย" } as never);
  assert.deepEqual(Object.keys(evt).sort(), ["policyOutcome", "resultCount", "subIntent", "timestamp"]);
  assert.ok(!("queryText" in evt));
  assert.ok(!JSON.stringify(log.all()).includes("เงินเดือน"));
});

test("audit prune drops events older than retention (90d)", () => {
  const log = createAuditLog();
  const now = 100 * 864e5;
  log.record({ subIntent: "PERSON_LOOKUP", policyOutcome: "ALLOW", resultCount: 1, timestamp: now - 91 * 864e5 });
  log.record({ subIntent: "PERSON_LOOKUP", policyOutcome: "ALLOW", resultCount: 1, timestamp: now - 10 * 864e5 });
  assert.equal(log.prune(now), 1);
  assert.equal(log.all().length, 1);
});

test("feedback: valid values aggregate per day; unknown rejected", () => {
  const fb = createFeedbackStore();
  const d1 = Date.parse("2026-07-12T03:00:00Z"); // Bangkok 2026-07-12
  const d2 = Date.parse("2026-07-13T03:00:00Z");
  assert.equal(fb.add("found", d1), true);
  assert.equal(fb.add("found", d1), true);
  assert.equal(fb.add("incorrect", d1), true);
  assert.equal(fb.add("not_matched", d2), true);
  assert.equal(fb.add("bogus", d1), false); // unknown ignored

  assert.deepEqual(fb.totals(), { found: 2, not_matched: 1, incorrect: 1 });
  assert.equal(fb.byDay()["2026-07-12"]?.found, 2);
  assert.equal(fb.byDay()["2026-07-13"]?.not_matched, 1);
});
