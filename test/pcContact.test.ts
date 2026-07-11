// WP-22.3 — contact draft. Draft text only; the module must never import a sender.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.OPENROUTER_API_KEY ??= "test-dummy";
const { draftContact, templateDraft } = await import("../src/people/contact/draft.ts");
import type { SearchResult } from "../src/people/retrieval/rank.ts";
import type { LlmCall } from "../src/people/intent/extract.ts";

const target: SearchResult = {
  kind: "tagged",
  profile: { displayName: "สมชาย ใจดี", nickname: "ชาย", email: "somchai@builk.com" },
  relationshipType: "OWNER",
  reasonCode: "owner_tag",
  matchedTag: "Pojjaman",
};

test("templateDraft includes the topic and addresses the target by nickname", () => {
  const d = templateDraft(target, "การเชื่อมต่อ Pojjaman", "จ้อ");
  assert.match(d, /พี่ชาย/);
  assert.match(d, /การเชื่อมต่อ Pojjaman/);
  assert.match(d, /จ้อ/);
});

test("draftContact without llm → template; with llm → polished; llm error → template", async () => {
  const base = await draftContact({ target, topic: "Pojjaman" });
  assert.match(base.draft, /Pojjaman/);

  const polished = await draftContact({ target, topic: "Pojjaman", llm: (async () => "ร่างที่ปรับแล้วเรื่อง Pojjaman ครับ") as LlmCall });
  assert.match(polished.draft, /ปรับแล้ว/);

  const errored = await draftContact({ target, topic: "Pojjaman", llm: (async () => { throw new Error("x"); }) as LlmCall });
  assert.match(errored.draft, /Pojjaman/); // fell back to template
});

test("module imports no message sender (MVP: user sends themselves)", () => {
  const src = readFileSync("src/people/contact/draft.ts", "utf8");
  assert.doesNotMatch(src, /channels\/teams|botframework|sendActivity|sendToConversation|proactive|sendMessage/i);
});
