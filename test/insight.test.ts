// WP-12 slice 4 — /insight command parser (Metric Contract §2.2 rules). Pure.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy"; // insight.ts imports env.ts
const { parseInsightCommand } = await import("../src/channels/insight.ts");
const { insightEnabled } = await import("../src/analytics/queue.ts");

test("bare /insight defaults to 7d", () => {
  assert.deepEqual(parseInsightCommand("/insight"), { kind: "report", days: 7 });
});

test("explicit windows 7d/14d/30d", () => {
  assert.deepEqual(parseInsightCommand("/insight 7d"), { kind: "report", days: 7 });
  assert.deepEqual(parseInsightCommand("/insight 14d"), { kind: "report", days: 14 });
  assert.deepEqual(parseInsightCommand("/insight 30d"), { kind: "report", days: 30 });
});

test("tolerates leading/trailing whitespace and multiple spaces", () => {
  assert.deepEqual(parseInsightCommand("   /insight   30d  "), { kind: "report", days: 30 });
});

test("command and argument are case-insensitive", () => {
  assert.deepEqual(parseInsightCommand("/INSIGHT"), { kind: "report", days: 7 });
  assert.deepEqual(parseInsightCommand("/Insight 14D"), { kind: "report", days: 14 });
});

test("invalid window → usage, never a guessed job", () => {
  assert.equal(parseInsightCommand("/insight 10d")?.kind, "usage");
  assert.equal(parseInsightCommand("/insight foo")?.kind, "usage");
  assert.equal(parseInsightCommand("/insight 7")?.kind, "usage");
});

test("extra tokens → usage (no guessing)", () => {
  assert.equal(parseInsightCommand("/insight 7d extra")?.kind, "usage");
});

test("/insight-status parses a jobId; missing id → usage", () => {
  assert.deepEqual(parseInsightCommand("/insight-status abc-123"), { kind: "status", jobId: "abc-123" });
  assert.equal(parseInsightCommand("/insight-status")?.kind, "usage");
  // must NOT be misread as a report command (\b matches the hyphen)
  assert.notEqual(parseInsightCommand("/insight-status abc")?.kind, "report");
});

test("non-insight text is not our command", () => {
  assert.equal(parseInsightCommand("สวัสดีครับ"), null);
  assert.equal(parseInsightCommand("/refresh"), null);
  assert.equal(parseInsightCommand("insight 7d"), null); // no leading slash
});

test("feature is disabled by default (INSIGHT_ENABLED unset)", () => {
  assert.equal(insightEnabled(), false);
});
