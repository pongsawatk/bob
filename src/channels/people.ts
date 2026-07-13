// People Connector — /people admin debug command. Everyone now gets People
// Connector answers via natural chat (router category PEOPLE → pipeline/index.ts),
// no command needed, once PEOPLE_ENABLED=1. This /people path is a secondary,
// admin-only (isInsightAdmin, same cohort as /insight) way to run a query directly
// and see the routing/grounding footer — useful for debugging intent/policy
// behavior without digging through Langfuse traces.

import { env } from "../env.js";
import { isInsightAdmin } from "./insight.js";
import { handlePeopleQuery, defaultPeopleDeps } from "../people/connector.js";

export function peopleEnabled(): boolean {
  return env.PEOPLE_ENABLED === "1";
}

export type PeopleCommand = { kind: "query"; query: string } | { kind: "usage" };

const USAGE = "ใช้: `/people <คำถาม>` เช่น `/people ทีม Jubili มีใครบ้าง` (โหมด debug สำหรับผู้ดูแลระบบ — พนักงานทั่วไปถามแบบข้อความปกติได้เลย ไม่ต้องใช้คำสั่งนี้)";

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
    return "ขออภัยครับ คำสั่ง /people (โหมด debug) ใช้ได้เฉพาะผู้ดูแลระบบครับ — ถามแบบข้อความปกติได้เลยนะครับ 🙏";
  }

  const res = await handlePeopleQuery(cmd.query, defaultPeopleDeps());
  // Debug footer so the admin can judge routing/grounding at a glance.
  const flag = res.usedFallback ? " · ⚠️fallback" : "";
  return `${res.text}\n\n_[debug · ${res.subIntent} · ${res.outcome} · ${res.resultCount} ผล${flag}]_`;
}
