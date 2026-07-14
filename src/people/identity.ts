// People Connector — requester identity resolution (WP-01).
//
// Binds the person asking to their directory profile so BOB can answer "หัวหน้าฉันคือใคร"
// without a name being typed. The join key is the **canonical company email** verified
// by the tenant (Teams → TeamsInfo.getMember), because the HR registry has no AAD
// object-id column; an OID→email map is a later enhancement, not a thing to fake now.
//
// Every failure mode is explicit and none of them guess. Display name is never a join
// key: names repeat, and a wrong bind would hand one employee another's reporting line.

import { createHash } from "node:crypto";
import type { Profile } from "./directory.js";
import type { ProfileMap } from "./profileStore.js";

/** Claims Teams actually gives us (verified in WP-00 against the live activity). */
export interface RequesterIdentity {
  /** canonical company email / UPN, lowercased. The only usable join key today. */
  email?: string;
  /** AAD object id — stable and immutable, but not present in the registry, so it
   *  cannot join to a profile on its own. Carried for telemetry + future mapping. */
  aadObjectId?: string;
  /** display name — deliberately NOT a join key. */
  displayName?: string;
}

export type IdentityResolution =
  | { status: "SELF_RESOLVED"; profile: Profile; key: string }
  | { status: "IDENTITY_NOT_FOUND" }
  | { status: "IDENTITY_AMBIGUOUS" }
  | { status: "PROFILE_INACTIVE" };

export type IdentityStatus = IdentityResolution["status"];

/** Pseudonymous, stable id for telemetry — lets us count self-resolution outcomes
 *  per person without putting an email in a trace or a log line. */
export function identityKey(email: string): string {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 16);
}

export interface ResolveInput {
  /** profiles BOB may serve (post employment-status gate). */
  servable: ProfileMap;
  /** every active profile, pre-gate — to tell "not in the registry" from "filtered out". */
  all: ProfileMap;
  identity: RequesterIdentity;
}

/**
 * Resolve the asker to exactly one servable profile, or say why not.
 *
 * Uniqueness is checked over the profile values rather than trusting the map key:
 * a duplicated email in the source sheet would otherwise silently collapse into
 * whichever row happened to be written last, and self-answers would go to the wrong
 * person. Two matches → IDENTITY_AMBIGUOUS, never a coin flip.
 */
export function resolveRequester(input: ResolveInput): IdentityResolution {
  const email = (input.identity.email ?? "").trim().toLowerCase();
  if (!email) return { status: "IDENTITY_NOT_FOUND" };

  const matches = Object.values(input.servable).filter((p) => p.email?.toLowerCase() === email);
  if (matches.length > 1) return { status: "IDENTITY_AMBIGUOUS" };

  const profile = matches[0];
  if (!profile) {
    // Present in the registry but not servable → their employment status excludes
    // them; that is a different answer from "we've never heard of you".
    const known = Object.values(input.all).some((p) => p.email?.toLowerCase() === email);
    return { status: known ? "PROFILE_INACTIVE" : "IDENTITY_NOT_FOUND" };
  }
  return { status: "SELF_RESOLVED", profile, key: identityKey(email) };
}
