// People Connector — deterministic ranking (plan §6). Fixed priority so results
// are explainable and reproducible: owner > expertise > open-to-discuss, then a
// stable name tiebreak. No scores, no LLM. Directory-only results (person/team/
// reporting lookups) are ordered by name and never interleave with tagged ones.

import type { RelationshipType, WorkProfile } from "../pcTypes.js";

export interface DirectorySearchResult {
  kind: "directory";
  profile: WorkProfile;
  /** why this row is here, e.g. "nickname_match", "team_member", "supervisor". */
  reasonCode: string;
}

export interface TaggedSearchResult {
  kind: "tagged";
  profile: WorkProfile;
  relationshipType: RelationshipType;
  reasonCode: string;
  /** the exact approved tag that matched (for the "reason" shown to the user). */
  matchedTag: string;
}

export type SearchResult = DirectorySearchResult | TaggedSearchResult;

/** Fixed relationship priority (lower = ranked first). owner > expertise >
 *  experienced > open-to-discuss > contact-point. */
export const RELATIONSHIP_RANK: Record<RelationshipType, number> = {
  OWNER: 0,
  EXPERT: 1,
  EXPERIENCED: 2,
  OPEN_TO_DISCUSS: 3,
  CONTACT_POINT: 4,
};

const byName = (a: WorkProfile, b: WorkProfile): number =>
  a.displayName.localeCompare(b.displayName, "th");

/** Sort tagged results by relationship priority then name. Pure; input untouched. */
export function rankTagged(results: readonly TaggedSearchResult[]): TaggedSearchResult[] {
  return [...results].sort(
    (a, b) =>
      RELATIONSHIP_RANK[a.relationshipType] - RELATIONSHIP_RANK[b.relationshipType] ||
      byName(a.profile, b.profile),
  );
}

/** Sort directory results by name (stable, deterministic). */
export function rankDirectory(results: readonly DirectorySearchResult[]): DirectorySearchResult[] {
  return [...results].sort((a, b) => byName(a.profile, b.profile));
}
