// WP-06 — follow-up context.
// "เอาเฉพาะ tester" after "ทีม DX มีใครบ้าง" ignored the previous turn entirely. The
// extractor always supported an ExtractOptions.history for exactly this, and the
// conversation history was already in Redis and already loaded per turn — the connector
// just never passed one to the other.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { handlePeopleQuery } = await import("../src/people/connector.ts");
const { retrieve } = await import("../src/people/retrieval/search.ts");
const { buildUserMessage } = await import("../src/people/intent/extract.ts");
import type { Profile } from "../src/people/directory.ts";
import type { IntentResult } from "../src/people/pcTypes.ts";

const P = (email: string, fullNameTh: string, position: string, subOrg: string): Profile => ({ email, fullNameTh, position, subOrg });
const directory: Record<string, Profile> = {
  "q1@x.com": P("q1@x.com", "กอ หนึ่ง", "QA Engineer", "DX"),
  "q2@x.com": P("q2@x.com", "ขอ สอง", "Software Tester", "DX"),
  "d1@x.com": P("d1@x.com", "จอ ห้า", "Senior Developer", "DX"),
};

// ── The extractor sees the previous turns ───────────────────────────────

test("the prior turns are included in the extractor's user message", () => {
  const msg = buildUserMessage("เอาเฉพาะ tester", [
    { role: "user", content: "ทีม DX มีใครบ้าง" },
    { role: "assistant", content: "ทีม DX มี 3 คนครับ" },
  ]);
  assert.match(msg, /ทีม DX มีใครบ้าง/);
  assert.match(msg, /คำถามล่าสุด: เอาเฉพาะ tester/);
});

test("no history → the message is unchanged (a first turn stays a first turn)", () => {
  const msg = buildUserMessage("ทีม DX มีใครบ้าง");
  assert.doesNotMatch(msg, /BOB:/);
});

// ── FOLLOW_UP_FILTER resolves against the directory ─────────────────────

test("a follow-up filter carrying the merged constraints answers as a roster query", () => {
  const intent: IntentResult = {
    subIntent: "FOLLOW_UP_FILTER",
    searchParams: { team: "DX", role: "tester" },
    confidence: 0.85,
    targetType: "TEAM",
  };
  const r = retrieve({ intent, directory });
  assert.deepEqual(r.results.map((x) => x.profile.email).sort(), ["q1@x.com", "q2@x.com"]);
  assert.equal(r.totalMatches, 2);
});

test("a follow-up filter counts the filtered set when asked how many", () => {
  const intent: IntentResult = {
    subIntent: "FOLLOW_UP_FILTER",
    searchParams: { team: "DX", role: "tester" },
    confidence: 0.85,
    countOnly: true,
    targetType: "TEAM",
  };
  const r = retrieve({ intent, directory });
  assert.equal(r.totalMatches, 2);
});

test("a follow-up with nothing to filter on still clarifies rather than listing everyone", () => {
  const intent: IntentResult = { subIntent: "FOLLOW_UP_FILTER", searchParams: {}, confidence: 0.85 };
  const r = retrieve({ intent, directory });
  assert.equal(r.totalMatches, 0);
  assert.equal(r.fallback, true);
});

// ── End-to-end: history reaches the extractor ───────────────────────────

test("the connector hands conversation history to the extractor", async () => {
  let seen = "";
  const res = await handlePeopleQuery(
    "เอาเฉพาะ tester",
    {
      intentLlm: async (user) => {
        seen = user;
        return JSON.stringify({ subIntent: "FOLLOW_UP_FILTER", searchParams: { team: "DX", role: "tester" }, confidence: 0.85 });
      },
      responderLlm: async () => "ทีม DX มี tester 2 คนครับ: กอ หนึ่ง, ขอ สอง",
      getDirectory: async () => directory,
      getKnownNames: async () => [],
    },
    { history: [{ role: "user", content: "ทีม DX มีใครบ้าง" }, { role: "assistant", content: "ทีม DX มี 3 คนครับ" }] },
  );
  assert.match(seen, /ทีม DX มีใครบ้าง/, "the previous turn must reach the extractor");
  assert.equal(res.resultCount, 2);
});

test("history is scoped per call — a connector call never sees another conversation's", async () => {
  const capture: string[] = [];
  const mk = (history: { role: "user" | "assistant"; content: string }[]) =>
    handlePeopleQuery(
      "เอาเฉพาะ tester",
      {
        intentLlm: async (user) => {
          capture.push(user);
          return JSON.stringify({ subIntent: "FOLLOW_UP_FILTER", searchParams: { team: "DX", role: "tester" }, confidence: 0.85 });
        },
        responderLlm: async () => "ครับ",
        getDirectory: async () => directory,
        getKnownNames: async () => [],
      },
      { history },
    );
  await mk([{ role: "user", content: "ทีม ALPHA มีใครบ้าง" }]);
  await mk([{ role: "user", content: "ทีม BETA มีใครบ้าง" }]);
  assert.match(capture[0] ?? "", /ALPHA/);
  assert.doesNotMatch(capture[0] ?? "", /BETA/);
  assert.match(capture[1] ?? "", /BETA/);
  assert.doesNotMatch(capture[1] ?? "", /ALPHA/, "no cross-conversation bleed");
});
