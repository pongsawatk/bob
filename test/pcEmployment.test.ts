// G0 §2.2 — employment-status gate. Inert by default; activates from env when HR
// fills the status column. Covers allowlist, denylist, no-status pass-through, and
// the connector honoring the policy.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { isServable, filterServable, employmentPolicyFromEnv } = await import("../src/people/policy/employment.ts");
const { handlePeopleQuery } = await import("../src/people/connector.ts");
import type { Profile } from "../src/people/directory.ts";
import type { PeopleDeps } from "../src/people/connector.ts";

test("isServable: no status → true (inert); no policy → true", () => {
  assert.equal(isServable(undefined, {}), true);
  assert.equal(isServable("ทดลองงาน", {}), true);
});

test("isServable: denylist excludes; allowlist restricts", () => {
  assert.equal(isServable("ทดลองงาน", { excludedStatuses: ["ทดลองงาน"] }), false);
  assert.equal(isServable("พนักงานประจำ", { activeStatuses: ["พนักงานประจำ", "สัญญาจ้าง"] }), true);
  assert.equal(isServable("outsource", { activeStatuses: ["พนักงานประจำ"] }), false);
  // denylist wins even if also in allowlist
  assert.equal(isServable("ทดลองงาน", { activeStatuses: ["ทดลองงาน"], excludedStatuses: ["ทดลองงาน"] }), false);
});

test("filterServable: empty policy returns the same map; policy drops excluded", () => {
  const dir: Record<string, Profile> = {
    "a@x.com": { email: "a@x.com", fullNameTh: "A", employmentType: "พนักงานประจำ" },
    "b@x.com": { email: "b@x.com", fullNameTh: "B", employmentType: "ทดลองงาน" },
    "c@x.com": { email: "c@x.com", fullNameTh: "C" }, // no status → kept
  };
  assert.equal(filterServable(dir, {}), dir); // identity when inert
  assert.deepEqual(Object.keys(filterServable(dir, { excludedStatuses: ["ทดลองงาน"] })).sort(), ["a@x.com", "c@x.com"]);
});

test("employmentPolicyFromEnv parses comma-separated values", () => {
  const p = employmentPolicyFromEnv({ PEOPLE_ACTIVE_STATUSES: "พนักงานประจำ, สัญญาจ้าง", PEOPLE_EXCLUDED_STATUSES: "" });
  assert.deepEqual(p.activeStatuses, ["พนักงานประจำ", "สัญญาจ้าง"]);
  assert.deepEqual(p.excludedStatuses, []);
});

test("connector honors the employment policy (excluded person not served)", async () => {
  const directory: Record<string, Profile> = {
    "somchai@builk.com": { email: "somchai@builk.com", fullNameTh: "สมชาย ใจดี", nickname: "ชาย", employmentType: "ทดลองงาน" },
  };
  const deps: PeopleDeps = {
    intentLlm: async () => JSON.stringify({ subIntent: "PERSON_LOOKUP", searchParams: { personRef: "ชาย" }, confidence: 0.9 }),
    responderLlm: async () => "ไม่ควรถึงตรงนี้",
    getDirectory: async () => directory,
    getKnownNames: async () => ["สมชาย ใจดี", "ชาย"],
    employmentPolicy: { excludedStatuses: ["ทดลองงาน"] },
    now: new Date("2026-07-12T00:00:00Z"),
  };
  const r = await handlePeopleQuery("พี่ชายอยู่ทีมไหน", deps);
  assert.equal(r.resultCount, 0);
  assert.match(r.text, /ยังไม่พบ/); // filtered out → not-found template
});
