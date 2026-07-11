// Continuous Improvement Analytics — deterministic aggregation over Langfuse traces.
// Implements Metric Contract v0.1 (docs/implementation/metric-contract.md). WP-10.
//
// Split by design:
//   • PURE CORE (normalizeTrace / normalizeAll / aggregate / percentile /
//     bangkokDayKey) — no I/O, no env, no clock except what's passed in. Golden-tested
//     in test/analytics.test.ts. THIS is where every number comes from (never the LLM).
//   • THIN I/O (fetchTraces) — paginates GET /api/public/traces. `fetch` is injectable
//     so it can be tested without a network; exercised for real in WP-12/13.
//
// Source shape is Langfuse's TraceWithDetails (verified against langfuse-core types):
// trace-level `latency` (seconds), `totalCost` (USD), `userId`, `sessionId`,
// `metadata`, `tags` — all written by src/pipeline/index.ts. No observation join needed.

// ── Metric Contract constants (§2, §3) ────────────────────────────────
/** Test/bot senders excluded before any metric (run-eval.mjs, dev server, CLIs). */
export const EXCLUDED_USER_IDS = new Set(["eval", "dev-user", "cli", "smoke", "qa"]);
/** Per-category max_tokens from domainBot.ts — a turn at/over its cap was truncated. */
export const OUTPUT_TOKEN_CAP: Record<string, number> = { HR: 1300, PRODUCT: 2000, GENERAL: 800 };
/** Only these traces are user turns. */
export const TRACE_NAME = "bob-chat";

export type Intent = "HR" | "PRODUCT" | "GENERAL" | "UNKNOWN" | "PEOPLE" | "OTHER";

// ── Types ─────────────────────────────────────────────────────────────

/** Subset of Langfuse TraceWithDetails that the contract consumes. */
export interface RawTrace {
  id: string;
  timestamp: string; // ISO 8601
  name?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  metadata?: unknown; // { category, latencyMs, outputTokens, ... } stamped by the pipeline
  tags?: string[] | null; // [channel, category, "llm"|"precache"]
  latency?: number | null; // seconds
  totalCost?: number | null; // USD
}

/** A normalized, contract-shaped user turn. rawUserId stays internal (never emitted). */
export interface NormalizedTurn {
  id: string;
  rawUserId: string;
  sessionId: string;
  tsMs: number;
  dayKey: string; // Bangkok yyyy-mm-dd
  intent: Intent;
  latencyMs: number;
  costUsd: number;
  outputTokens: number;
  truncated: boolean;
  fromCache: boolean;
  channel: string;
  hasCategory: boolean; // completeness signal
  hasLatency: boolean; // completeness signal
}

export interface Window {
  fromMs: number;
  toMs: number;
} // half-open [fromMs, toMs)

export interface MetricReport {
  window: { from: string; to: string; days: number };
  completeness: number; // 0..1 — fraction of turns with category + latency
  turns: number;
  uniqueUsers: number;
  sessions: number;
  repeatUsers: number; // users active on >= 2 distinct Bangkok days
  repeatUserRate: number;
  oneShotRate: number; // sessions with exactly 1 turn / sessions
  intents: Record<string, number>; // turn count per intent
  unknownTurns: number;
  truncatedTurns: number;
  fromCacheTurns: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  costUsd: number;
}

// ── Pure helpers ──────────────────────────────────────────────────────

const num = (x: unknown): number => (typeof x === "number" && isFinite(x) ? x : 0);

/** Matches the existing analyze-langfuse.mjs percentile exactly (kept identical so
 *  the two tools never disagree): nearest-rank on a copy-sorted array. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

const BKK_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** Bangkok calendar day "yyyy-mm-dd" for a timestamp (mirrors kb/holidays.ts). */
export function bangkokDayKey(tsMs: number): string {
  return BKK_DAY.format(new Date(tsMs));
}

function normalizeIntent(c?: string): Intent {
  switch (c) {
    case "HR":
    case "PRODUCT":
    case "GENERAL":
    case "UNKNOWN":
    case "PEOPLE":
      return c;
    default:
      return "OTHER";
  }
}

/** Raw trace → normalized turn, applying contract exclusions. Returns null for
 *  non-`bob-chat` traces, missing/anonymous users, and excluded test/bot senders. */
export function normalizeTrace(t: RawTrace): NormalizedTurn | null {
  if (t.name && t.name !== TRACE_NAME) return null;
  const rawUserId = (t.userId ?? "").toLowerCase();
  if (!rawUserId || EXCLUDED_USER_IDS.has(rawUserId)) return null;

  const md = (t.metadata && typeof t.metadata === "object" ? t.metadata : {}) as Record<string, unknown>;
  const tags = t.tags ?? [];
  const catRaw = typeof md.category === "string" ? md.category : undefined;
  const outputTokens = num(md.outputTokens);
  const cap = catRaw ? OUTPUT_TOKEN_CAP[catRaw] : undefined;
  const tsMs = Date.parse(t.timestamp);
  // Prefer trace-level latency (seconds → ms); fall back to the pipeline's metadata.
  const latencyMs = t.latency != null ? t.latency * 1000 : num(md.latencyMs);

  return {
    id: t.id,
    rawUserId,
    sessionId: t.sessionId ?? t.id, // a turn with no session is its own single-turn session
    tsMs,
    dayKey: bangkokDayKey(tsMs),
    intent: normalizeIntent(catRaw),
    latencyMs,
    costUsd: num(t.totalCost),
    outputTokens,
    truncated: cap != null && outputTokens >= cap,
    fromCache: tags.includes("precache"),
    channel: typeof tags[0] === "string" ? tags[0] : "unknown", // pipeline sets tags[0] = channel
    hasCategory: catRaw != null,
    hasLatency: latencyMs > 0,
  };
}

/** Dedupe by trace id (guards paginated/late-event duplicates, contract §4), then
 *  normalize + drop excluded rows. Order-preserving. */
export function normalizeAll(raws: RawTrace[]): NormalizedTurn[] {
  const seen = new Set<string>();
  const out: NormalizedTurn[] = [];
  for (const r of raws) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const n = normalizeTrace(r);
    if (n) out.push(n);
  }
  return out;
}

/** Aggregate normalized turns for one half-open window. All numbers from code. */
export function aggregate(turns: NormalizedTurn[], window: Window): MetricReport {
  const inWin = turns.filter((t) => t.tsMs >= window.fromMs && t.tsMs < window.toMs);
  const total = inWin.length;

  const users = new Set<string>();
  const sessionTurns = new Map<string, number>();
  const userDays = new Map<string, Set<string>>();
  const intents: Record<string, number> = {};
  const latencies: number[] = [];
  let complete = 0;
  let cost = 0;
  let truncated = 0;
  let unknown = 0;
  let fromCache = 0;

  for (const t of inWin) {
    users.add(t.rawUserId);
    sessionTurns.set(t.sessionId, (sessionTurns.get(t.sessionId) ?? 0) + 1);
    let days = userDays.get(t.rawUserId);
    if (!days) userDays.set(t.rawUserId, (days = new Set()));
    days.add(t.dayKey);
    intents[t.intent] = (intents[t.intent] ?? 0) + 1;
    if (t.intent === "UNKNOWN") unknown++;
    if (t.truncated) truncated++;
    if (t.fromCache) fromCache++;
    if (t.hasLatency) latencies.push(t.latencyMs);
    if (t.hasCategory && t.hasLatency) complete++;
    cost += t.costUsd;
  }

  const repeatUsers = [...userDays.values()].filter((d) => d.size >= 2).length;
  const oneShotSessions = [...sessionTurns.values()].filter((n) => n === 1).length;

  return {
    window: {
      from: new Date(window.fromMs).toISOString(),
      to: new Date(window.toMs).toISOString(),
      days: Math.round((window.toMs - window.fromMs) / 86_400_000),
    },
    completeness: total ? complete / total : 1,
    turns: total,
    uniqueUsers: users.size,
    sessions: sessionTurns.size,
    repeatUsers,
    repeatUserRate: users.size ? repeatUsers / users.size : 0,
    oneShotRate: sessionTurns.size ? oneShotSessions / sessionTurns.size : 0,
    intents,
    unknownTurns: unknown,
    truncatedTurns: truncated,
    fromCacheTurns: fromCache,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    costUsd: cost,
  };
}

/** Current + previous comparison windows of equal length ending at `now`. */
export function windowFor(days: number, now: number = Date.now()): { current: Window; previous: Window } {
  const span = days * 86_400_000;
  return {
    current: { fromMs: now - span, toMs: now },
    previous: { fromMs: now - 2 * span, toMs: now - span },
  };
}

// ── Thin I/O layer (not unit-tested; `fetch` injectable) ───────────────

export interface LangfuseCreds {
  host: string;
  publicKey: string;
  secretKey: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** Paginated GET /api/public/traces over a window. Retries 5xx a few times. */
export async function fetchTraces(
  creds: LangfuseCreds,
  window: Window,
  opts: { fetchImpl?: FetchLike; pageLimit?: number } = {}
): Promise<RawTrace[]> {
  const f = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const auth = "Basic " + Buffer.from(`${creds.publicKey}:${creds.secretKey}`).toString("base64");
  const host = creds.host.replace(/\/$/, "");
  const from = new Date(window.fromMs).toISOString();
  const to = new Date(window.toMs).toISOString();
  const limit = opts.pageLimit ?? 100;

  const all: RawTrace[] = [];
  for (let page = 1; ; page++) {
    const url =
      `${host}/api/public/traces?limit=${limit}&page=${page}` +
      `&fromTimestamp=${encodeURIComponent(from)}&toTimestamp=${encodeURIComponent(to)}`;
    let res: Awaited<ReturnType<FetchLike>> | undefined;
    for (let attempt = 1; ; attempt++) {
      res = await f(url, { headers: { Authorization: auth } });
      if (res.ok) break;
      if (res.status >= 500 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw new Error(`GET /traces ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { data?: RawTrace[]; meta?: { totalPages?: number } };
    const data = body.data ?? [];
    all.push(...data);
    const totalPages = body.meta?.totalPages ?? 1;
    if (page >= totalPages || data.length === 0) break;
  }
  return all;
}
