// Deterministic redaction — the privacy boundary for Continuous Improvement Analytics
// (WP-11, Metric Contract §5). NOTHING sampled from a trace reaches the analysis LLM
// or the report before passing through here. Redaction is code, never the model.
//
// Scope: mask emails, URLs, secrets/tokens, employee ids, Thai national ids, phone
// numbers, @mentions, and (list-driven) known employee names. Aggregate numbers are
// never redacted — short counts like "30 วัน" must survive, so patterns target
// identifier-shaped strings, not any digit.
//
// Order matters: broader/prefixed patterns run before narrower numeric ones so a
// value is masked as a single unit (e.g. "EMP-00123" → [id], not [id]-[phone]).

export type RedactKind = "url" | "email" | "token" | "id" | "phone" | "mention" | "name";

export interface RedactResult {
  text: string;
  counts: Record<RedactKind, number>;
}

interface Rule {
  kind: RedactKind;
  re: RegExp;
}

// Applied in this exact order.
const RULES: Rule[] = [
  { kind: "url", re: /\bhttps?:\/\/[^\s]+/gi },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Secrets/tokens: sk-… keys, "Bearer …", and any long opaque alphanumeric run.
  { kind: "token", re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { kind: "token", re: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi },
  { kind: "token", re: /\b[A-Za-z0-9_-]{32,}\b/g },
  // Employee ids like EMP-00123 (prefix-anchored → safe from over-matching).
  { kind: "id", re: /\bEMP-?\d{3,}\b/gi },
  // Thai national id: 13 digits, plain or dashed 1-2345-67890-12-3.
  { kind: "id", re: /\b\d-\d{4}-\d{5}-\d{2}-\d\b/g },
  { kind: "id", re: /\b\d{13}\b/g },
  // Thai phone numbers: +66/0 prefix, 9–10 digits, optional separators.
  { kind: "phone", re: /(?:\+?66|0)[-\s]?\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4}\b/g },
  // Bare @handles (emails already consumed above).
  { kind: "mention", re: /@[A-Za-z0-9._-]{2,}/g },
];

const PLACEHOLDER: Record<RedactKind, string> = {
  url: "[url]",
  email: "[email]",
  token: "[token]",
  id: "[id]",
  phone: "[phone]",
  mention: "[mention]",
  name: "[name]",
};

/**
 * Redact identifier-shaped strings and (optionally) known names from free text.
 * @param opts.names exact employee names/nicknames to mask (from the directory).
 *   Masked last, longest-first, so "สมชาย ใจดี" is masked before "สมชาย".
 */
export function redact(input: unknown, opts: { names?: string[] } = {}): RedactResult {
  let text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const counts: Record<RedactKind, number> = {
    url: 0, email: 0, token: 0, id: 0, phone: 0, mention: 0, name: 0,
  };

  for (const { kind, re } of RULES) {
    text = text.replace(re, () => {
      counts[kind]++;
      return PLACEHOLDER[kind];
    });
  }

  // Name masking is list-driven (Thai has no regex word boundaries). Longest names
  // first prevents a substring name from partially masking a longer full name.
  const names = [...new Set((opts.names ?? []).filter((n) => n && n.trim().length >= 2))].sort(
    (a, b) => b.length - a.length
  );
  for (const name of names) {
    if (!text.includes(name)) continue;
    const parts = text.split(name);
    counts.name += parts.length - 1;
    text = parts.join(PLACEHOLDER.name);
  }

  return { text, counts };
}

/**
 * Assert a payload is safe to send to the LLM/report: returns the list of leak kinds
 * still present after redaction (empty = clean). Used as a defense-in-depth gate and
 * in the redaction test suite. Names must be passed to be checked.
 */
export function findLeaks(text: string, names: string[] = []): string[] {
  const leaks: string[] = [];
  if (/\bhttps?:\/\//i.test(text)) leaks.push("url");
  if (/@[A-Za-z0-9._-]{2,}/.test(text)) leaks.push("email/mention");
  if (/\bsk-[A-Za-z0-9]{16,}\b/.test(text) || /\b[A-Za-z0-9_-]{32,}\b/.test(text)) leaks.push("token");
  if (/\b\d{11,}\b/.test(text)) leaks.push("long-number");
  if (/(?:\+?66|0)[-\s]?\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4}\b/.test(text)) leaks.push("phone");
  for (const n of names) if (n && text.includes(n)) { leaks.push("name"); break; }
  return leaks;
}
