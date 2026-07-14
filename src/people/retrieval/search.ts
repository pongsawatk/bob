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
import { canonicalRole, rawRoleMatchesPosition, roleMatchesPosition } from "./roles.js";

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
  /** page size for roster results; defaults to PC_CONFIG.TEAM_ROSTER_MAX. */
  limit?: number;
  /** the asker's own profile, when their identity resolved (WP-01). Required for
   *  targetType SELF; absent means we must not answer a self question at all. */
  requester?: Profile;
}

/** The canonical filters retrieval actually applied — echoed back so the answer can
 *  state what was searched, and so a dropped constraint is visible in a trace. */
export interface FiltersApplied {
  team?: string;
  bu?: string;
  role?: string;
  personRef?: string;
  topic?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** exact number of individuals matching every filter, before paging (WP-02). */
  totalMatches: number;
  /** how many of them this response actually carries. */
  shownCount: number;
  /** shownCount < totalMatches → the responder MUST disclose both. */
  truncated: boolean;
  /** emails of the candidates in `results` — the responder's name allowlist (WP-03). */
  candidateIds: string[];
  /** canonical filters used to produce this result. */
  filtersApplied: FiltersApplied;
  /** the caller asked "how many": totalMatches is the answer and `results` is empty
   *  on purpose, so no roster reaches the LLM. */
  countOnly: boolean;
  /** no individual matched → caller should point to a team/contact point. */
  fallback: boolean;
  /** unresolved lookup → offer the correction path instead of guessing. */
  suggestCorrection: boolean;
  /** results are BOB's best guess inferred from Org/Sub Org/position (not an
   *  approved ownership tag) → the responder must add a "confirm with HR" note. */
  inferred?: boolean;
  /** the person has no supervisor in the registry (top of the org, or a blank cell).
   *  A real, explainable answer — not a search miss. */
  noSupervisor?: boolean;
}

/** Token-substring match of a free-text topic/team across Org/Sub Org/Group/
 *  Department/Function/Position. Strips a leading team/แผนก word; every token
 *  (>=2 chars) must appear. Sorted by name, capped. Shared by TEAM_ROSTER and the
 *  ownership inference path (HR: interpret ownership from Org/Sub Org). */
export function matchByTopic(dir: ProfileMap, query: string, cap: number): Profile[] {
  const stripped = norm(query).replace(/^(ทีม|แผนก|ฝ่าย|กลุ่ม|team|department|dept\.?)\s*/i, "").trim();
  const tokens = (stripped || norm(query)).split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  return Object.values(dir)
    .filter((p) => {
      const hay = [p.org, p.subOrg, p.group, p.department, p.team, p.position].map(norm).join(" | ");
      return tokens.every((t) => hay.includes(t));
    })
    .sort((a, b) => a.fullNameTh.localeCompare(b.fullNameTh, "th"))
    .slice(0, cap);
}

export function toWorkProfile(p: Profile, tags?: TagInfo, now = new Date()): WorkProfile {
  const t = p.startDate ? tenure(p.startDate, now) : null;
  return {
    displayName: p.fullNameTh || p.fullNameEn || p.email,
    nickname: p.nickname,
    email: p.email,
    org: p.org,
    subOrg: p.subOrg ?? p.department,
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
  totalMatches: 0,
  shownCount: 0,
  truncated: false,
  candidateIds: [],
  filtersApplied: {},
  countOnly: false,
  fallback: false,
  suggestCorrection: false,
  ...over,
});

/** Build a response from the full match set: page it, and derive the totals /
 *  candidate allowlist from one place so they can never disagree. `countOnly`
 *  keeps the totals but ships no rows. */
function page(
  all: readonly SearchResult[],
  opts: { limit: number; countOnly: boolean; filtersApplied: FiltersApplied; inferred?: boolean },
): SearchResponse {
  const shown = opts.countOnly ? [] : all.slice(0, opts.limit);
  return {
    results: [...shown],
    totalMatches: all.length,
    shownCount: shown.length,
    truncated: shown.length < all.length && !opts.countOnly,
    candidateIds: shown.map((r) => r.profile.email ?? "").filter(Boolean),
    filtersApplied: opts.filtersApplied,
    countOnly: opts.countOnly,
    fallback: false,
    suggestCorrection: false,
    ...(opts.inferred ? { inferred: true } : {}),
  };
}

/** Apply a role constraint to a candidate list. A role the taxonomy knows filters by
 *  concept; one it doesn't still filters by raw substring. Never returns the input
 *  unfiltered — silently dropping this constraint is the P0-2 bug. */
function applyRole(people: readonly Profile[], rawRole: string): { people: Profile[]; canonical: string } {
  const canon = canonicalRole(rawRole);
  const people2 = canon
    ? people.filter((p) => roleMatchesPosition(p.position, canon))
    : people.filter((p) => rawRoleMatchesPosition(p.position, rawRole));
  return { people: people2, canonical: canon ?? rawRole.trim() };
}

const dir = (p: Profile, reasonCode: string, input: RetrieveInput): DirectorySearchResult => ({
  kind: "directory",
  profile: toWorkProfile(p, input.tags?.[p.email], input.now),
  reasonCode,
});

/** Sub-intents where "about me" is a meaningful question. A first-person pronoun in
 *  anything else ("อยากคุยเรื่อง X กับเรา") is just phrasing — it must not divert the
 *  query into the self path. */
const SELF_INTENTS: ReadonlySet<SubIntent> = new Set<SubIntent>([
  "REPORTING_LINE",
  "PERSON_LOOKUP",
  "TENURE",
  "TEAM_ROSTER",
]);

const TAG_INTENT: Partial<Record<SubIntent, { rel: RelationshipType; field: keyof TagInfo; reason: string }>> = {
  OWNER_LOOKUP: { rel: "OWNER", field: "ownershipTags", reason: "owner_tag" },
  EXPERT_FIND: { rel: "EXPERT", field: "expertiseTags", reason: "expertise_tag" },
  IDEA_CONNECT: { rel: "OPEN_TO_DISCUSS", field: "openToDiscussTags", reason: "open_to_discuss_tag" },
};

export function retrieve(input: RetrieveInput): SearchResponse {
  const { intent, directory } = input;
  const sp = intent.searchParams;
  const ref = (sp.personRef || sp.topic || "").trim();
  const countOnly = intent.countOnly === true;

  // ── SELF (WP-01) ──────────────────────────────────────────────────────
  // Answered from the requester's own profile. Name search is bypassed entirely:
  // nothing was typed to search for, and falling through to it is exactly how the
  // production rc=0 happened. No requester → no answer, never a guess.
  if (intent.targetType === "SELF" && SELF_INTENTS.has(intent.subIntent)) {
    if (!input.requester) return empty({ filtersApplied: { personRef: "self" } });
    const me = input.requester;

    if (intent.subIntent === "REPORTING_LINE") {
      const sup = findSupervisor(directory, me.email);
      if (sup.status !== "resolved") {
        // "You're at the top" and "your Supervisor cell is broken" both mean we have
        // no name to give — say so rather than invent one.
        return empty({ noSupervisor: true, filtersApplied: { personRef: "self" } });
      }
      return page([dir(sup.supervisor, "supervisor", input)], {
        limit: 1,
        countOnly: false,
        filtersApplied: { personRef: "self" },
      });
    }

    // "ทีมผมมีใครบ้าง" asks about the team, not the person — resolve which team from
    // the requester's profile, then answer it as an ordinary roster query.
    if (intent.subIntent === "TEAM_ROSTER") {
      const myTeam = me.subOrg || me.department || me.team || me.org;
      if (!norm(myTeam)) return empty({ fallback: true, filtersApplied: { personRef: "self" } });
      return retrieve({
        ...input,
        intent: { ...intent, targetType: "TEAM", searchParams: { ...sp, team: myTeam } },
      });
    }

    // PERSON_LOOKUP / TENURE → own profile. tenure is computed from startDate in
    // toWorkProfile, never read from a snapshot column.
    return page([dir(me, intent.subIntent === "TENURE" ? "self_tenure" : "self_profile", input)], {
      limit: 1,
      countOnly: false,
      filtersApplied: { personRef: "self" },
    });
  }

  switch (intent.subIntent) {
    // TENURE about someone else resolves the same way as any person lookup; the
    // tenure figure is already part of the approved projection (toWorkProfile).
    case "TENURE":
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
      return page(ordered, {
        limit: input.limit ?? PC_CONFIG.MAX_RESULTS_FIRST_PAGE,
        countOnly,
        filtersApplied: { personRef: ref },
      });
    }

    case "TEAM_ROSTER": {
      const rawTeam = (sp.team || sp.topic || "").trim();
      const bu = (sp.bu || "").trim();
      const role = (sp.role || "").trim();
      // A role alone is a legitimate query ("ใครเป็น QA บ้าง"); team/bu alone still is too.
      if (!norm(rawTeam) && !norm(bu) && !norm(role)) return empty({ fallback: true });
      const filtersApplied: FiltersApplied = {};

      let members = norm(rawTeam)
        ? matchByTopic(directory, rawTeam, Number.MAX_SAFE_INTEGER)
        : Object.values(directory).sort((a, b) => a.fullNameTh.localeCompare(b.fullNameTh, "th"));
      if (norm(rawTeam)) filtersApplied.team = rawTeam;

      // AND, not OR: each filter narrows what the previous one left.
      const nbu = norm(bu);
      if (nbu) {
        members = members.filter((p) => [p.org, p.subOrg].some((f) => norm(f).includes(nbu)));
        filtersApplied.bu = bu;
      }
      if (norm(role)) {
        const applied = applyRole(members, role);
        members = applied.people;
        filtersApplied.role = applied.canonical;
      }

      if (members.length === 0) return empty({ fallback: true, filtersApplied });
      return page(members.map((p) => dir(p, "team_member", input)), {
        limit: input.limit ?? PC_CONFIG.TEAM_ROSTER_MAX,
        countOnly,
        filtersApplied,
      });
    }

    case "REPORTING_LINE": {
      if (!norm(ref)) return empty({ suggestCorrection: true });
      const person = findByNickname(directory, ref)[0] ?? findByName(directory, ref)[0];
      if (!person) return empty({ fallback: true, suggestCorrection: true });
      const sup = findSupervisor(directory, person.email);
      if (sup.status !== "resolved") return empty({ fallback: true, suggestCorrection: true });
      return page([dir(sup.supervisor, "supervisor", input)], {
        limit: 1,
        countOnly: false, // "who is X's boss" is never a count question
        filtersApplied: { personRef: ref },
      });
    }

    case "OWNER_LOOKUP":
    case "EXPERT_FIND":
    case "IDEA_CONNECT":
    case "EXPERIENCE_FIND":
    case "TEAM_DISCOVERY":
      return topicSearch(input, ref);

    case "CONTACT_HELP":
    case "FOLLOW_UP_FILTER":
    case "CORRECTION":
      return empty();
    default:
      return empty();
  }
}

/** Topic intents (owner/expert/idea/experience/team-discovery). Prefer an approved
 *  tag match (confident); otherwise INFER from Org/Sub Org/position and flag it so
 *  the responder adds a "please confirm with HR" note (HR: ownership is read off
 *  Org/Sub Org; BOB suggests but may misread). Nothing → fallback. */
function topicSearch(input: RetrieveInput, topic: string): SearchResponse {
  if (!norm(topic)) return empty({ fallback: true });
  if (TAG_INTENT[input.intent.subIntent]) {
    const tagged = tagSearch(input, topic);
    if (tagged.results.length > 0) return tagged; // confident, not inferred
  }
  const inferred = matchByTopic(input.directory, topic, PC_CONFIG.MAX_RESULTS_FIRST_PAGE);
  if (inferred.length === 0) return empty({ fallback: true, filtersApplied: { topic } });
  return page(inferred.map((p) => dir(p, "inferred_org", input)), {
    limit: input.limit ?? PC_CONFIG.MAX_RESULTS_FIRST_PAGE,
    countOnly: input.intent.countOnly === true,
    filtersApplied: { topic },
    inferred: true,
  });
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
  if (matched.length === 0) return empty({ fallback: true, filtersApplied: { topic } });
  return page(rankTagged(matched), {
    limit: input.limit ?? PC_CONFIG.MAX_RESULTS_FIRST_PAGE,
    countOnly: input.intent.countOnly === true,
    filtersApplied: { topic },
  });
}
