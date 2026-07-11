// WP-12 slice 1 — job state-machine spine (pure). No Redis/QStash/env.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bangkokDay,
  jobIdempotencyKey,
  stageClaimTag,
  newJob,
  Deadline,
  nextFetchStep,
  InMemoryJobStore,
  type FetchCursor,
} from "../src/analytics/job.ts";

const ms = (iso: string) => Date.parse(iso);

// ── Idempotency ────────────────────────────────────────────────────────
test("jobIdempotencyKey: stable per (user, window, Bangkok day); differs otherwise", () => {
  const t = ms("2026-07-11T05:00:00+07:00");
  const a = jobIdempotencyKey("aad-1", 7, t);
  assert.equal(a, jobIdempotencyKey("AAD-1", 7, ms("2026-07-11T23:00:00+07:00"))); // same day, case-insensitive
  assert.notEqual(a, jobIdempotencyKey("aad-1", 30, t)); // different window
  assert.notEqual(a, jobIdempotencyKey("aad-2", 7, t)); // different user
  assert.notEqual(a, jobIdempotencyKey("aad-1", 7, ms("2026-07-12T05:00:00+07:00"))); // next day
});

test("bangkokDay: rolls at Bangkok midnight, not UTC", () => {
  assert.equal(bangkokDay(ms("2026-12-31T18:00:00Z")), "2027-01-01"); // 01:00 next day in Bangkok
});

test("stageClaimTag: encodes stage + optional cursor page", () => {
  assert.equal(stageClaimTag("fetch", 3), "fetch:3");
  assert.equal(stageClaimTag("aggregate"), "aggregate");
});

test("newJob: starts queued at the fetch stage with keys set", () => {
  const j = newJob({ requestedBy: "aad-1", windowDays: 30, nowMs: ms("2026-07-11T05:00:00+07:00") });
  assert.equal(j.stage, "fetch");
  assert.equal(j.status, "queued");
  assert.equal(j.cursor, null);
  assert.ok(j.idempotencyKey.length === 32);
  assert.match(j.stateRef, /^bob:insight:job:.*:state$/);
});

// ── Deadline budget guard ──────────────────────────────────────────────
test("Deadline: yields only when the margin is reached", () => {
  const start = 1_000_000;
  const d = new Deadline(45_000, start);
  assert.equal(d.shouldYield(5000, start + 10_000), false); // 35s left
  assert.equal(d.shouldYield(5000, start + 40_000), true); //  5s left → yield
  assert.equal(d.remainingMs(start + 40_000), 5000);
});

// ── Resumable fetch decision ───────────────────────────────────────────
test("nextFetchStep: continue when pages remain and budget is fine", () => {
  const d = new Deadline(45_000, 1_000_000);
  const r = nextFetchStep({ page: 2, totalPages: 4, fetched: 100 }, { page: 2, totalPages: 4, count: 100 }, d, 1_010_000);
  assert.equal(r.action, "continue");
  assert.equal(r.cursor.page, 3);
  assert.equal(r.cursor.fetched, 200);
});

test("nextFetchStep: yield when pages remain but budget is spent", () => {
  const d = new Deadline(45_000, 1_000_000);
  const r = nextFetchStep({ page: 2, totalPages: 4, fetched: 100 }, { page: 2, totalPages: 4, count: 100 }, d, 1_041_000);
  assert.equal(r.action, "yield");
  assert.equal(r.cursor.page, 3); // resume here next invocation
});

test("nextFetchStep: advance on the last page (or an empty page)", () => {
  const d = new Deadline(45_000, 1_000_000);
  const last = nextFetchStep({ page: 3, totalPages: 4, fetched: 300 }, { page: 4, totalPages: 4, count: 50 }, d, 1_010_000);
  assert.equal(last.action, "advance");
  assert.equal(last.cursor.fetched, 350);
  const empty = nextFetchStep(null, { page: 1, totalPages: 9, count: 0 }, d, 1_010_000);
  assert.equal(empty.action, "advance");
});

// ── InMemoryJobStore ───────────────────────────────────────────────────
test("JobStore: create dedupes on idempotencyKey", async () => {
  const store = new InMemoryJobStore();
  const j1 = newJob({ requestedBy: "aad-1", windowDays: 7, nowMs: ms("2026-07-11T05:00:00+07:00") });
  const first = await store.create(j1);
  assert.equal(first.created, true);
  // Same admin/window/day → same idempotencyKey → second create returns the existing job.
  const j2 = { ...newJob({ requestedBy: "aad-1", windowDays: 7, nowMs: ms("2026-07-11T09:00:00+07:00") }), idempotencyKey: j1.idempotencyKey };
  const second = await store.create(j2);
  assert.equal(second.created, false);
  assert.equal(second.existing?.jobId, j1.jobId);
});

test("JobStore: update patches and bumps updatedAt; get/getByIdempotency work", async () => {
  const store = new InMemoryJobStore();
  const j = newJob({ requestedBy: "aad-1", windowDays: 14 });
  await store.create(j);
  const upd = await store.update(j.jobId, { stage: "aggregate", status: "running" });
  assert.equal(upd.stage, "aggregate");
  assert.equal(upd.status, "running");
  assert.equal((await store.get(j.jobId))?.stage, "aggregate");
  assert.equal((await store.getByIdempotency(j.idempotencyKey))?.jobId, j.jobId);
});

test("JobStore: claimStage is true once then false (at-least-once dedup)", async () => {
  const store = new InMemoryJobStore();
  const j = newJob({ requestedBy: "aad-1", windowDays: 7 });
  await store.create(j);
  assert.equal(await store.claimStage(j.jobId, stageClaimTag("fetch", 1)), true);
  assert.equal(await store.claimStage(j.jobId, stageClaimTag("fetch", 1)), false); // duplicate delivery
  assert.equal(await store.claimStage(j.jobId, stageClaimTag("fetch", 2)), true); // different page ok
});
