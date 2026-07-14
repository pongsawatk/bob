// WP-05 — alias & ambiguity layer.
// From the production pull: Thai team names and abbreviations returned 0 results
// ("ทีมบัญชี" → 0, "PJM" → 0) because retrieval only ever did token-substring matching
// on whatever the user typed. Aliases are deterministic and versioned in code, not
// prompt text, so a wrong mapping is caught by a test rather than a reroll.
//
// Synthetic fixture only.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { resolveTeamAlias, ALIAS_DICTIONARY_VERSION } = await import("../src/people/retrieval/aliases.ts");
const { retrieve } = await import("../src/people/retrieval/search.ts");
import type { Profile } from "../src/people/directory.ts";
import type { IntentResult } from "../src/people/pcTypes.ts";

const P = (email: string, fullNameTh: string, o: Partial<Profile>): Profile => ({ ...o, email, fullNameTh });

// Two distinct accounting-ish concepts — the ambiguity "ทีมบัญชี" must not silently pick one.
const directory: Record<string, Profile> = {
  "a1@x.com": P("a1@x.com", "เอ หนึ่ง", { subOrg: "Accounting", position: "Accountant" }),
  "a2@x.com": P("a2@x.com", "เอ สอง", { subOrg: "Accounting", position: "Accountant" }),
  "f1@x.com": P("f1@x.com", "เอฟ หนึ่ง", { subOrg: "Finance And Accounting", position: "Finance Officer" }),
  "f2@x.com": P("f2@x.com", "เอฟ สอง", { subOrg: "Finance And Accounting", position: "Finance Officer" }),
  "p1@x.com": P("p1@x.com", "พี หนึ่ง", { subOrg: "Pojjaman Development", position: "Developer" }),
  "c1@x.com": P("c1@x.com", "ซี หนึ่ง", { org: "ConTech", position: "Consultant" }),
};

test("alias dictionary is versioned so a mapping change is traceable", () => {
  assert.match(ALIAS_DICTIONARY_VERSION, /^\d+$/);
});

// ── Unambiguous aliases resolve to the registry's own spelling ──────────
// The dictionary stores a matcher, never a spelling: the real value comes from the
// live directory, so a team HR renames degrades to `unknown` (raw match) instead of
// silently matching nothing.

test("PJM / dev pjm resolve to the Pojjaman team (the abbreviation returned 0 in production)", () => {
  const r = resolveTeamAlias(directory, "PJM");
  assert.equal(r.status === "resolved" && r.canonical, "Pojjaman Development");
  const r2 = resolveTeamAlias(directory, "dev pjm");
  assert.equal(r2.status === "resolved" && r2.canonical, "Pojjaman Development");
});

test("คอนเทค resolves to ConTech across scripts", () => {
  const r = resolveTeamAlias(directory, "คอนเทค");
  assert.equal(r.status === "resolved" && r.canonical, "ConTech");
});

test("an unknown term is passthrough, not an error (retrieval still tries it raw)", () => {
  assert.equal(resolveTeamAlias(directory, "Marketing").status, "unknown");
});

test("a known alias whose team no longer exists degrades to unknown, not a wrong match", () => {
  const noPjm = { ...directory };
  delete noPjm["p1@x.com"];
  assert.equal(resolveTeamAlias(noPjm, "PJM").status, "unknown");
});

// ── Ambiguity: ask, never guess ─────────────────────────────────────────

test("ทีมบัญชี is ambiguous when the registry really carries two accounting teams", () => {
  const r = resolveTeamAlias(directory, "ทีมบัญชี");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.status === "ambiguous" ? [...r.options].sort() : [], ["Accounting", "Finance And Accounting"]);
});

test("the same term is unambiguous when only one such team exists (data decides)", () => {
  const onlyAccounting = { "a1@x.com": directory["a1@x.com"]!, "a2@x.com": directory["a2@x.com"]! };
  const r = resolveTeamAlias(onlyAccounting, "ทีมบัญชี");
  assert.equal(r.status === "resolved" && r.canonical, "Accounting");
});

test("the leading team/แผนก word is stripped before matching", () => {
  assert.equal(resolveTeamAlias(directory, "แผนกบัญชี").status, "ambiguous");
  const r = resolveTeamAlias(directory, "ทีม PJM");
  assert.equal(r.status === "resolved" && r.canonical, "Pojjaman Development");
});

// ── Through retrieval ───────────────────────────────────────────────────

const roster = (team: string): IntentResult => ({
  subIntent: "TEAM_ROSTER",
  searchParams: { team },
  confidence: 0.9,
  targetType: "TEAM",
});

test('"PJM" finds the Pojjaman team instead of returning no-result', () => {
  const r = retrieve({ intent: roster("PJM"), directory });
  assert.equal(r.totalMatches, 1);
  assert.deepEqual(r.results.map((x) => x.profile.email), ["p1@x.com"]);
});

test('"ทีมบัญชี" asks which team is meant rather than picking one', () => {
  const r = retrieve({ intent: roster("ทีมบัญชี"), directory });
  assert.equal(r.needsClarification, true);
  assert.deepEqual([...(r.clarifyOptions ?? [])].sort(), ["Accounting", "Finance And Accounting"]);
  assert.equal(r.results.length, 0, "must not answer with a guessed team");
});

test("resolving the ambiguity by naming the real team works", () => {
  const r = retrieve({ intent: roster("Accounting"), directory });
  assert.equal(r.totalMatches, 2);
  assert.deepEqual(r.results.map((x) => x.profile.email).sort(), ["a1@x.com", "a2@x.com"]);
});

test("filtersApplied reports the canonical concept that was used", () => {
  const r = retrieve({ intent: roster("PJM"), directory });
  assert.equal(r.filtersApplied.team, "Pojjaman Development");
});

test("an alias resolving to a team nobody is in is a clean no-result, not a crash", () => {
  const r = retrieve({ intent: roster("PJM"), directory: { "c1@x.com": directory["c1@x.com"]! } });
  assert.equal(r.totalMatches, 0);
  assert.equal(r.fallback, true);
});
