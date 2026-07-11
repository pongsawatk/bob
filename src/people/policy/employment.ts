// People Connector — employment-status gate (G0 §2.2). Decides whether a profile
// may be served at all, based on the HR "employment status" column. The exact
// status values are HR's policy call and not known yet, so this is fully
// config-driven and INERT by default:
//   - no status on the profile (column empty/absent) → servable (shadow + back-compat)
//   - no policy configured                            → servable (nothing filtered)
// When HR provides the values, set PEOPLE_ACTIVE_STATUSES (allowlist) and/or
// PEOPLE_EXCLUDED_STATUSES (denylist) and the gate activates with no code change.

import { norm, type ProfileMap } from "../profileStore.js";

export interface EmploymentPolicy {
  /** Allowlist: if non-empty, ONLY these statuses are servable. */
  activeStatuses?: string[];
  /** Denylist: these statuses are never servable (applied first). */
  excludedStatuses?: string[];
}

const has = (list: string[] | undefined, s: string): boolean =>
  !!list && list.some((x) => norm(x) === s);

/** True if a profile with this employment status may be served. */
export function isServable(employmentType: string | undefined, policy: EmploymentPolicy): boolean {
  const s = norm(employmentType);
  if (!s) return true; // no status data → don't filter (inert until the column is filled)
  if (has(policy.excludedStatuses, s)) return false;
  const allow = policy.activeStatuses;
  if (allow && allow.length > 0) return allow.some((x) => norm(x) === s);
  return true;
}

/** Keep only servable profiles. Returns the same map when the policy is empty. */
export function filterServable(dir: ProfileMap, policy: EmploymentPolicy): ProfileMap {
  if (!policy.activeStatuses?.length && !policy.excludedStatuses?.length) return dir;
  const out: ProfileMap = {};
  for (const [email, p] of Object.entries(dir)) {
    if (isServable(p.employmentType, policy)) out[email] = p;
  }
  return out;
}

const splitCsv = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Build the policy from env (comma-separated). Empty env → inert policy. */
export function employmentPolicyFromEnv(env: { PEOPLE_ACTIVE_STATUSES?: string; PEOPLE_EXCLUDED_STATUSES?: string }): EmploymentPolicy {
  return {
    activeStatuses: splitCsv(env.PEOPLE_ACTIVE_STATUSES),
    excludedStatuses: splitCsv(env.PEOPLE_EXCLUDED_STATUSES),
  };
}
