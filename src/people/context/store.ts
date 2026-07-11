// People Connector — short-lived conversation context (plan §3.2, WP-22.1).
// Holds ONLY the last result set + intent per conversation, in memory, with a
// TTL. Never persisted (it is not HR data — see §3.2), and expires so a stale
// follow-up ("มีคนอื่นอีกไหม") forces a fresh search instead of guessing.
//
// createContextStore() gives each caller (and each test) its own Map, so there
// is no shared global state. Follow-up transforms are exported as pure functions.

import { PC_CONFIG } from "../pcConfig.js";
import type { IntentResult } from "../pcTypes.js";
import type { SearchResult } from "../retrieval/rank.js";

export interface ContextEntry {
  intent: IntentResult;
  /** the full ranked result set (may exceed one page — supports "ดูเพิ่ม"). */
  results: SearchResult[];
  createdAt: number;
  /** how many have already been shown (pagination cursor). */
  served: number;
}

const TTL_MS = PC_CONFIG.CONTEXT_TTL_MINUTES * 60_000;

export interface ContextStore {
  save(conversationId: string, intent: IntentResult, results: SearchResult[], now?: number): ContextEntry;
  get(conversationId: string, now?: number): ContextEntry | null;
  clear(conversationId: string): void;
}

export function createContextStore(): ContextStore {
  const map = new Map<string, ContextEntry>();
  return {
    save(conversationId, intent, results, now = Date.now()) {
      const entry: ContextEntry = { intent, results, createdAt: now, served: 0 };
      map.set(conversationId, entry);
      return entry;
    },
    get(conversationId, now = Date.now()) {
      const e = map.get(conversationId);
      if (!e) return null;
      if (now - e.createdAt >= TTL_MS) {
        map.delete(conversationId); // expired → force a fresh search
        return null;
      }
      return e;
    },
    clear(conversationId) {
      map.delete(conversationId);
    },
  };
}

// ── Pure follow-up transforms (§3.2) — operate on a stored result set ──────

const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** "คนที่ N" — 1-based; out of range → []. */
export function pickByIndex(results: readonly SearchResult[], n: number): SearchResult[] {
  const i = n - 1;
  return i >= 0 && i < results.length ? [results[i]!] : [];
}

/** "ขอเฉพาะคนใน X" — match org / subOrg / functionTeam (exact-normalized). */
export function filterByTeam(results: readonly SearchResult[], team: string): SearchResult[] {
  const t = norm(team);
  if (!t) return [];
  return results.filter((r) => [r.profile.org, r.profile.subOrg, r.profile.functionTeam].some((f) => norm(f) === t));
}

/** "ขอเฉพาะ owner โดยตรง" — keep only tagged OWNER rows. */
export function ownerOnly(results: readonly SearchResult[]): SearchResult[] {
  return results.filter((r) => r.kind === "tagged" && r.relationshipType === "OWNER");
}

/** "มีคนอื่นอีกไหม" — advance the cursor, returning the next `count` and the new
 *  served total. Empty slice means nothing more to show. */
export function takeNext(entry: ContextEntry, count: number): { slice: SearchResult[]; served: number } {
  const slice = entry.results.slice(entry.served, entry.served + count);
  return { slice, served: entry.served + slice.length };
}
