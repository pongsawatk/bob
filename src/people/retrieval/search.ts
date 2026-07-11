// People Connector — deterministic retrieval (plan §6, §3.3, §10). Turns an
// IntentResult into approved-projection results over the live directory
// (profileStore) plus a G0-supplied TagMap. The LLM never reaches here: matching
// is exact-normalized only, results are capped, and directory vs tagged shapes
// never blend. Directory sub-intents work today; tag sub-intents return nothing
// until the G0 TagMap is populated (the code + tests exist so go-live is a data
// flip, not a code change).

import type { Profile } from "../directory.js";
import { findByName, findByNickname, findSupervisor, norm, tenure, type ProfileMap } from "../profileStore.js";
import { PC_CONFIG } from "../pcConfig.js";
import type { IntentResult, RelationshipType, SubIntent, WorkProfile } from "../pcTypes.js";
import {
  rankTagged,
  type DirectorySearchResult,
  type SearchResult,
  type TaggedSearchResult,
} from "./rank.js";

export interface TagInfo {
  ownershipTags?: string[];
  expertiseTags?: string[];
  openToDiscussTags?: string[];
  contactPreference?: "teams" | "email";
  tagsConfirmedAt?: string | null;
}
/** Approved tags keyed by email — from the G0 source; empty until approved. */
export type TagMap = Record<string, TagInfo>;

/** Build the TagMap from the directory itself (the G0 ownership column lives in the
 *  same HR sheet). Only profiles that actually carry tags get an entry, so an empty
 *  column yields an empty map and tag intents stay dark. expertise/openToDiscuss are
 *  Phase-next (self-service) and not sourced here yet. */
export function tagMapFromDirectory(dir: ProfileMap): TagMap {
  const out: TagMap = {};
  for (const [email, p] of Object.entries(dir)) {
    if (p.ownershipTags && p.ownershipTags.length) out[email] = { ownershipTags: p.ownershipTags };
  }
  return out;
}

export interface RetrieveInput {
  intent: IntentResult;
  directory: ProfileMap;
  tags?: TagMap;
  now?: Date;
}

export interface SearchResponse {
  results: SearchResult[];
  /** total individual matches before the first-page cap (for "ดูเพิ่ม"). */
  total: number;
  /** no individual matched → caller should point to a team/contact point. */
  fallback: boolean;
  /** unresolved lookup → offer the correction path instead of guessing. */
  suggestCorrection: boolean;
}

export function toWorkProfile(p: Profile, tags?: TagInfo, now = new Date()): WorkProfile {
  const t = p.startDate ? tenure(p.startDate, now) : null;
  return {
    displayName: p.fullNameTh || p.fullNameEn || p.email,
    nickname: p.nickname,
    email: p.email,
    org: p.org,
    subOrg: p.department,
    position: p.position,
    functionTeam: p.team,
    supervisor: p.supervisor,
    startDate: p.startDate,
    tenureYears: t?.years,
    tenureMonths: t?.months,
    ownershipTags: tags?.ownershipTags,
    expertiseTags: tags?.expertiseTags,
    openToDiscussTags: tags?.openToDiscussTags,
    contactPreference: tags?.contactPreference,
    tagsConfirmedAt: tags?.tagsConfirmedAt ?? null,
  };
}

const empty = (over: Partial<SearchResponse> = {}): SearchResponse => ({
  results: [],
  total: 0,
  fallback: false,
  suggestCorrection: false,
  ...over,
});

const dir = (p: Profile, reasonCode: string, input: RetrieveInput): DirectorySearchResult => ({
  kind: "directory",
  profile: toWorkProfile(p, input.tags?.[p.email], input.now),
  reasonCode,
});

const TAG_INTENT: Partial<Record<SubIntent, { rel: RelationshipType; field: keyof TagInfo; reason: string }>> = {
  OWNER_LOOKUP: { rel: "OWNER", field: "ownershipTags", reason: "owner_tag" },
  EXPERT_FIND: { rel: "EXPERT", field: "expertiseTags", reason: "expertise_tag" },
  IDEA_CONNECT: { rel: "OPEN_TO_DISCUSS", field: "openToDiscussTags", reason: "open_to_discuss_tag" },
};

export function retrieve(input: RetrieveInput): SearchResponse {
  const { intent, directory } = input;
  const sp = intent.searchParams;
  const ref = (sp.personRef || sp.topic || "").trim();

  switch (intent.subIntent) {
    case "PERSON_LOOKUP": {
      if (!norm(ref)) return empty({ suggestCorrection: true });
      const seen = new Set<string>();
      const ordered: DirectorySearchResult[] = [];
      for (const p of findByNickname(directory, ref)) {
        if (!seen.has(p.email)) (seen.add(p.email), ordered.push(dir(p, "nickname_match", input)));
      }
      for (const p of findByName(directory, ref)) {
        if (!seen.has(p.email)) (seen.add(p.email), ordered.push(dir(p, "name_match", input)));
      }
      if (ordered.length === 0) return empty({ fallback: true, suggestCorrection: true });
      return {
        results: ordered.slice(0, PC_CONFIG.MAX_RESULTS_FIRST_PAGE),
        total: ordered.length,
        fallback: false,
        suggestCorrection: false,
      };
    }

    case "TEAM_ROSTER": {
      const team = (sp.team || sp.topic || "").trim();
      const bu = (sp.bu || "").trim();
      if (!norm(team) && !norm(bu)) return empty({ fallback: true });
      const members = Object.values(directory)
        .filter((p) => {
          const teamOk = norm(team) ? [p.org, p.department, p.team].some((f) => norm(f) === norm(team)) : true;
          const buOk = norm(bu) ? norm(p.org) === norm(bu) : true;
          return teamOk && buOk;
        })
        .sort((a, b) => a.fullNameTh.localeCompare(b.fullNameTh, "th"));
      if (members.length === 0) return empty({ fallback: true });
      return {
        results: members.slice(0, PC_CONFIG.TEAM_ROSTER_MAX).map((p) => dir(p, "team_member", input)),
        total: members.length,
        fallback: false,
        suggestCorrection: false,
      };
    }

    case "REPORTING_LINE": {
      if (!norm(ref)) return empty({ suggestCorrection: true });
      const person = findByNickname(directory, ref)[0] ?? findByName(directory, ref)[0];
      if (!person) return empty({ fallback: true, suggestCorrection: true });
      const sup = findSupervisor(directory, person.email);
      if (sup.status !== "resolved") return empty({ fallback: true, suggestCorrection: true });
      return { results: [dir(sup.supervisor, "supervisor", input)], total: 1, fallback: false, suggestCorrection: false };
    }

    case "OWNER_LOOKUP":
    case "EXPERT_FIND":
    case "IDEA_CONNECT":
      return tagSearch(input, ref);

    // Out-of-scope for MVP retrieval — handled by context/responder or a later
    // phase (plan §10). Return a clean fallback so callers can route.
    case "TEAM_DISCOVERY":
    case "EXPERIENCE_FIND":
      return empty({ fallback: true });
    case "CONTACT_HELP":
    case "FOLLOW_UP_FILTER":
    case "CORRECTION":
      return empty();
    default:
      return empty();
  }
}

/** Tag-based match (owner/expert/open-to-discuss). Exact-normalized topic match
 *  against the approved tag arrays; joins directory info; ranked + capped. */
function tagSearch(input: RetrieveInput, topic: string): SearchResponse {
  const spec = TAG_INTENT[input.intent.subIntent];
  if (!spec || !norm(topic)) return empty({ fallback: true });
  const tags = input.tags ?? {};
  const matched: TaggedSearchResult[] = [];
  for (const [email, info] of Object.entries(tags)) {
    const p = input.directory[email];
    if (!p) continue; // can't serve someone not in the directory
    const arr = (info[spec.field] as string[] | undefined) ?? [];
    const hit = arr.find((t) => norm(t) === norm(topic));
    if (hit) {
      matched.push({
        kind: "tagged",
        profile: toWorkProfile(p, info, input.now),
        relationshipType: spec.rel,
        reasonCode: spec.reason,
        matchedTag: hit,
      });
    }
  }
  if (matched.length === 0) return empty({ fallback: true });
  const ranked = rankTagged(matched);
  return {
    results: ranked.slice(0, PC_CONFIG.MAX_RESULTS_FIRST_PAGE),
    total: ranked.length,
    fallback: false,
    suggestCorrection: false,
  };
}
