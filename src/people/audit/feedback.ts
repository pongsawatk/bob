// People Connector — feedback (plan §9, WP-22.4). Three values only, aggregated
// per day. Never tied to an individual staff member and never used to rank people
// — only to measure the feature (found rate, no-match, wrong match).

export const FEEDBACK_VALUES = ["found", "not_matched", "incorrect"] as const;
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];

export type DayCounts = Record<FeedbackValue, number>;

const zero = (): DayCounts => ({ found: 0, not_matched: 0, incorrect: 0 });

/** Asia/Bangkok calendar day (deterministic, independent of runner TZ). */
const dayKey = (now: number): string => new Date(now + 7 * 3600e3).toISOString().slice(0, 10);

export const isFeedbackValue = (x: unknown): x is FeedbackValue =>
  typeof x === "string" && (FEEDBACK_VALUES as readonly string[]).includes(x);

export interface FeedbackStore {
  /** Records one vote; ignores unknown values (returns false). */
  add(value: unknown, now?: number): boolean;
  /** Per-day aggregate, keyed by YYYY-MM-DD. */
  byDay(): Record<string, DayCounts>;
  /** Totals across all days. */
  totals(): DayCounts;
}

export function createFeedbackStore(): FeedbackStore {
  const days = new Map<string, DayCounts>();
  return {
    add(value, now = Date.now()) {
      if (!isFeedbackValue(value)) return false;
      const key = dayKey(now);
      const d = days.get(key) ?? zero();
      d[value]++;
      days.set(key, d);
      return true;
    },
    byDay() {
      return Object.fromEntries([...days.entries()].map(([k, v]) => [k, { ...v }]));
    },
    totals() {
      const t = zero();
      for (const d of days.values()) for (const v of FEEDBACK_VALUES) t[v] += d[v];
      return t;
    },
  };
}
