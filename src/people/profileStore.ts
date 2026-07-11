// People Connector — deterministic cross-person retrieval over the employee
// directory (directory.ts). These are PURE query/ranking helpers: they take the
// active-profile map as input and never touch Graph/Redis themselves, so they
// are trivially testable with fixtures. Live callers pass getActiveDirectory().
//
// Reuses the existing Profile shape + HR ETL from directory.ts — People Connector
// does NOT re-import the sheet (the plan's separate-CSV ETL is intentionally
// dropped). Tag-based matching (owner/expertise/open-to-discuss) is gated on G0
// and lives in the retrieval layer; this store exposes only the directory-fact
// lookups that work with data we already have live. Because directory.ts never
// imports a payroll/employee ID, there is no sourceEmployeeId to strip here.

import type { Profile } from "./directory.js";

export type ProfileMap = Record<string, Profile>;

/** Normalize for deterministic matching: lowercase, NFC, collapse whitespace, trim.
 *  No semantic/fuzzy guessing — People Connector matches are exact-normalized only. */
export const norm = (s: unknown): string =>
  String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** Stable Thai-aware sort by Thai full name (deterministic result ordering). */
const byName = (a: Profile, b: Profile): number =>
  a.fullNameTh.localeCompare(b.fullNameTh, "th");

/** Exact (normalized) nickname match. Nicknames are not unique, so returns a list. */
export function findByNickname(map: ProfileMap, nickname: string): Profile[] {
  const n = norm(nickname);
  if (!n) return [];
  return Object.values(map)
    .filter((p) => norm(p.nickname) === n)
    .sort(byName);
}

/** Normalized substring match across Thai name, English name, and nickname.
 *  Requires >= 2 chars so a single letter can't enumerate the directory. */
export function findByName(map: ProfileMap, query: string): Profile[] {
  const n = norm(query);
  if (n.length < 2) return [];
  return Object.values(map)
    .filter(
      (p) =>
        norm(p.fullNameTh).includes(n) ||
        (p.fullNameEn ? norm(p.fullNameEn).includes(n) : false) ||
        norm(p.nickname).includes(n),
    )
    .sort(byName);
}

export type SupervisorResolution =
  | { status: "none" }
  | { status: "unresolved"; raw: string }
  | { status: "resolved"; supervisor: Profile; raw: string };

/** Resolve a person's supervisor. The sheet's Supervisor cell is free text — an
 *  email or a full name. Resolve by email first, then by exact-normalized name.
 *  Never guesses: 0 or >1 name matches → `unresolved`; a self-reference is also
 *  treated as `unresolved` (broken cell, not a real report line). */
export function findSupervisor(map: ProfileMap, email: string): SupervisorResolution {
  const p = map[String(email).toLowerCase()];
  const raw = (p?.supervisor ?? "").trim();
  if (!raw) return { status: "none" };

  const byEmail = map[raw.toLowerCase()];
  if (byEmail) {
    return byEmail.email === p?.email ? { status: "unresolved", raw } : { status: "resolved", supervisor: byEmail, raw };
  }

  const nraw = norm(raw);
  const matches = Object.values(map).filter(
    (q) => norm(q.fullNameTh) === nraw || (q.fullNameEn ? norm(q.fullNameEn) === nraw : false),
  );
  if (matches.length === 1 && matches[0] && matches[0].email !== p?.email) {
    return { status: "resolved", supervisor: matches[0], raw };
  }
  return { status: "unresolved", raw };
}

export interface TeamFilter {
  org?: string;
  department?: string;
  team?: string;
}

/** Members whose provided org/department/team fields all match (exact-normalized).
 *  Empty/whitespace-only filter → [] (never returns the whole company). Capped to
 *  guard against team-roster enumeration; results are name-sorted for determinism. */
export function listTeamMembers(map: ProfileMap, filter: TeamFilter, cap = 20): Profile[] {
  const criteria = (Object.entries(filter) as [keyof TeamFilter, string | undefined][]).filter(
    ([, v]) => norm(v).length > 0,
  );
  if (criteria.length === 0) return [];
  return Object.values(map)
    .filter((p) => criteria.every(([k, v]) => norm(p[k]) === norm(v)))
    .sort(byName)
    .slice(0, cap);
}

/** Whole years/months of tenure from an ISO start date, evaluated in Asia/Bangkok
 *  wall-clock and NOT rounded up (matches directory.tenureTh's month math). Returns
 *  null for a missing/malformed date; a future start date clamps to 0/0. Tenure is
 *  for display context only — callers must never use it as a ranking signal. */
export function tenure(
  startDate: string | undefined,
  now: Date = new Date(),
): { years: number; months: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate ?? "");
  if (!m) return null;
  const sy = Number(m[1]);
  const sm = Number(m[2]) - 1;
  const sd = Number(m[3]);
  // Shift to Bangkok (+07:00) and read calendar parts off the UTC accessors.
  const bkk = new Date(now.getTime() + 7 * 3600 * 1000);
  const ny = bkk.getUTCFullYear();
  const nm = bkk.getUTCMonth();
  const nd = bkk.getUTCDate();
  let months = (ny - sy) * 12 + (nm - sm);
  if (nd < sd) months--;
  if (months <= 0) return { years: 0, months: 0 };
  return { years: Math.floor(months / 12), months: months % 12 };
}
