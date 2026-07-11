// WP-22.1 — conversation context TTL + follow-up transforms.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { createContextStore, pickByIndex, filterByTeam, ownerOnly, takeNext } = await import(
  "../src/people/context/store.ts"
);
import type { SearchResult } from "../src/people/retrieval/rank.ts";
import type { IntentResult } from "../src/people/pcTypes.ts";

const dir = (email: string, displayName: string, subOrg?: string): SearchResult => ({
  kind: "directory",
  profile: { displayName, email, subOrg },
  reasonCode: "team_member",
});
const owner = (displayName: string): SearchResult => ({
  kind: "tagged",
  profile: { displayName },
  relationshipType: "OWNER",
  reasonCode: "owner_tag",
  matchedTag: "Pojjaman",
});

const intent: IntentResult = { subIntent: "TEAM_ROSTER", searchParams: { team: "Eng" }, confidence: 0.9 };
const results: SearchResult[] = [dir("a@x.com", "A", "Eng"), dir("b@x.com", "B", "Sales"), owner("C")];

test("save/get within TTL, expires after 30 min", () => {
  const s = createContextStore();
  s.save("c1", intent, results, 0);
  assert.ok(s.get("c1", 1_799_999)); // < 30 min
  assert.equal(s.get("c1", 1_800_000), null); // == 30 min → expired + deleted
  assert.equal(s.get("c1", 1_800_001), null); // stays gone
});

test("pickByIndex is 1-based, out of range → []", () => {
  assert.equal(pickByIndex(results, 1)[0]?.profile.displayName, "A");
  assert.equal(pickByIndex(results, 3)[0]?.profile.displayName, "C");
  assert.deepEqual(pickByIndex(results, 4), []);
  assert.deepEqual(pickByIndex(results, 0), []);
});

test("filterByTeam matches subOrg/team, empty → []", () => {
  assert.deepEqual(filterByTeam(results, "Eng").map((r) => r.profile.email), ["a@x.com"]);
  assert.deepEqual(filterByTeam(results, ""), []);
});

test("ownerOnly keeps tagged OWNER only", () => {
  assert.deepEqual(ownerOnly(results).map((r) => r.profile.displayName), ["C"]);
});

test("takeNext paginates from the served cursor", () => {
  const s = createContextStore();
  const e = s.save("c2", intent, results, 0);
  const first = takeNext(e, 2);
  assert.deepEqual(first.slice.map((r) => r.profile.displayName), ["A", "B"]);
  assert.equal(first.served, 2);
  e.served = first.served;
  const second = takeNext(e, 2);
  assert.deepEqual(second.slice.map((r) => r.profile.displayName), ["C"]);
  assert.equal(second.served, 3);
});
