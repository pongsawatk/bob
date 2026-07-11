// People Connector — engineering defaults (plan §1). Single source so thresholds
// live in one place and tests are deterministic. These are ENGINEERING defaults
// for building/testing; the real policy values still require G0/HR/Data-Owner
// sign-off before go-live (do not treat as approved policy).

export const PC_CONFIG = Object.freeze({
  /** confidence ≥ this → answer immediately (when no policy block). */
  CONFIDENCE_HIGH: 0.8,
  /** confidence in [MID, HIGH) → clarify / show options. Below MID → UNABLE_TO_DETERMINE. */
  CONFIDENCE_MID: 0.5,
  /** conversation context lifetime (minutes). */
  CONTEXT_TTL_MINUTES: 30,
  /** tags freshness window from tagsConfirmedAt (days). */
  PROFILE_FRESHNESS_DAYS: 180,
  /** person-search first page size. */
  MAX_RESULTS_FIRST_PAGE: 3,
  /** total people served per conversation (anti-enumeration). */
  MAX_RESULTS_TOTAL: 10,
  /** roster cap for an explicitly named team. */
  TEAM_ROSTER_MAX: 20,
  /** directory email shown by default (For All registry). */
  SHOW_EMAIL_DEFAULT: true,
  /** audit/feedback retention (days). */
  AUDIT_RETENTION_DAYS: 90,
});

export type PcConfig = typeof PC_CONFIG;
