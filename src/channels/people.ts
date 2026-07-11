// People Connector — admin-shadow /people command (Wave-1 wiring). Inert unless
// PEOPLE_ENABLED=1; gated to the same admin cohort as /insight (isInsightAdmin).
// This is a SEPARATE path from normal chat — it does not change BOB's default
// "refuse info about others" behavior; only an admin explicitly invoking /people
// gets cross-person directory answers, so we can shadow-test before any pilot.

import { env } from "../env.js";
import { isInsightAdmin } from "./insight.js";
import { handlePeopleQuery, defaultPeopleDeps } from "../people/connector.js";

export function peopleEnabled(): boolean {
  return env.PEOPLE_ENABLED === "1";
}

export type PeopleCommand = { kind: "query"; query: string } | { kind: "usage" };

const USAGE = "ใช้: `/people <คำถาม>` เช่น `/people ทีม Jubili มีใครบ้าง` (โหมดทดสอบสำหรับผู้ดูแลระบบ)";

/** Pure parser (like parseInsightCommand). Returns null when it isn't our command. */
export function parsePeopleCommand(raw: string): PeopleCommand | null {
  const text = raw.trim();
  if (!/^\/people\b/i.test(text)) return null;
  const query = text.replace(/^\/people\b/i, "").trim();
  return query ? { kind: "query", query } : { kind: "usage" };
}

export async function handlePeopleCommand(
  cmd: PeopleCommand,
  who: { aadObjectId: string; email: string },
): Promise<string> {
  if (cmd.kind === "usage") return USAGE;

  if (!(await isInsightAdmin(who.aadObjectId, who.email))) {
    return "ขออภัยครับ /people ยังเปิดเฉพาะผู้ดูแลระบบสำหรับทดสอบ (shadow) เท่านั้นครับ";
  }

  const res = await handlePeopleQuery(cmd.query, defaultPeopleDeps());
  // Shadow footer so the admin can judge routing/grounding at a glance.
  const flag = res.usedFallback ? " · ⚠️fallback" : "";
  return `${res.text}\n\n_[shadow · ${res.subIntent} · ${res.outcome} · ${res.resultCount} ผล${flag}]_`;
}
