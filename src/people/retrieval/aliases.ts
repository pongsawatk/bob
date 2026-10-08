// People Connector — team/org alias layer (WP-05).
//
// Deterministic and versioned in code, NOT in a prompt: "ทีมบัญชี" landing on the wrong
// department is a data bug, and a data bug should fail a test rather than depend on a
// model's mood. Roles/positions are a separate concern and live in ./roles.ts.
//
// Sourced from no-result mining on the 2026-07-14 production pull: Thai team names and
// abbreviations ("ทีมบัญชี", "PJM", "dev pjm", "คอนเทค") returned 0, because retrieval only
// token-matched the literal words typed against the registry's own spellings.
//
// The dictionary deliberately does NOT store what a team is "called" in the registry.
// Registry spellings are production data that drifts as HR edits the sheet, and
// hard-coding a guess ("Finance And Accounting") silently returns nothing the day it
// stops matching. Instead each alias carries a MATCHER, and the live directory
// supplies the real values — so ambiguity is discovered from the data rather than
// asserted here, and a renamed team degrades to "unknown" (raw match) instead of a
// confident zero.

import { norm, type ProfileMap } from "../profileStore.js";

/** Bump when a mapping changes, so a routing shift is traceable to a dictionary
 *  version rather than looking like model drift. */
export const ALIAS_DICTIONARY_VERSION = "2";

interface AliasEntry {
  /** what a user might type (normalized, leading "ทีม"/"team" already stripped). */
  forms: string[];
  /** identifies the registry values this concept covers, tested against normalized
   *  Org / Sub Org / Group / Department / Function cells. */
  match: RegExp;
}

const ALIASES: AliasEntry[] = [
  { forms: ['hr', 'human resource', 'human resources', 'บุคคล', 'ทรัพยากรบุคคล'], match: /^human resources?$|^hr$|บุคคล/ },
  { forms: ['it', 'ไอที', 'it administration'], match: /^it$|^it administration$/ },
  { forms: ['cs', 'cx', 'customer success'], match: /^cx$|^customer success$/ },
  // "บัญชี" is genuinely ambiguous wherever the registry carries both an accounting
  // team and a combined finance+accounting one — the matcher spans both on purpose so
  // the ambiguity surfaces and BOB asks instead of picking.
  { forms: ["บัญชี", "accounting", "accountant"], match: /account|บัญชี/ },
  { forms: ["การเงิน", "finance"], match: /finance|การเงิน/ },
  {
    forms: ["การเงินและบัญชี", "finance and accounting", "account finance", "account and finance"],
    match: /(?:account.*finance|finance.*account|การเงินและบัญชี)/,
  },
  { forms: ["pjm", "dev pjm", "pjm dev", "pojjaman", "พจมาน"], match: /pojjaman|pjm|พจมาน/ },
  { forms: ["คอนเทค", "contech", "con tech"], match: /contech|คอนเทค/ },
];

export type GroupField = 'org' | 'subOrg' | 'group' | 'department' | 'team';
/** Honor a literal column + live value before accepting an LLM's split of that phrase. */
export function explicitColumnScope(query: string, dir: ProfileMap): { dimension: GroupField; value: string } | undefined {
  const markers=[...query.matchAll(/\b(corporate\s+department|department|function\s*\/\s*team|sub\s*org|org|group)\b/gi)];
  if(markers.length!==1)return;
  const marker=markers[0]!;
  const key=norm(marker[1]).replace(/\s+/g,'');
  const dimension:GroupField=key.includes('department')?'department':key==='suborg'?'subOrg':key==='function/team'?'team':key==='group'?'group':'org';
  const tail=norm(query.slice(marker.index!+marker[0].length)).replace(/^[\s:="'(]+/,'');
  const values=[...new Set(Object.values(dir).map(p=>p[dimension]).filter((v):v is string=>!!v))];
  const hits=values.filter(v=>tail.startsWith(norm(v)) && /^(?:$|\s|[?.,)"']|มี|กี่|ขอ|คือ|ครับ|ค่ะ)/.test(tail.slice(norm(v).length))).sort((a,b)=>b.length-a.length);
  if(hits[0])return{dimension,value:hits[0]};
}
export type TeamScope = { status: 'resolved'; canonical: string; fields: GroupField[] } | { status: 'ambiguous'; options: string[] } | { status: 'unknown' };
/** Org/Sub Org is the default dimension. Other columns are never unioned into it. */
export function resolveTeamScope(dir: ProfileMap, raw: string, dimension: 'primary' | GroupField = 'primary'): TeamScope {
  const n = stripLead(norm(raw));
  const fields: GroupField[] = dimension === 'primary' ? ['org', 'subOrg'] : [dimension];
  const values = new Map<string, string>();
  for (const p of Object.values(dir)) for (const f of fields) if (p[f]) values.set(norm(p[f]), p[f]!);
  if (values.has(n)) return { status: 'resolved', canonical: values.get(n)!, fields };
  const entry = ALIASES.find(a => a.forms.includes(n));
  const matches = entry ? [...values].filter(([k]) => entry.match.test(k)).map(([,v]) => v) : [];
  // IT and IT Administration often describe the same people. Collapse only proven identical sets.
  const groups = new Map<string, string>();
  for (const v of matches) {
    const ids = Object.values(dir).filter(p => fields.some(f => norm(p[f]) === norm(v))).map(p => p.email).sort().join('|');
    if (!groups.has(ids)) groups.set(ids, v);
  }
  const options = [...groups.values()];
  if (options.length === 1) return { status: 'resolved', canonical: options[0]!, fields };
  if (options.length > 1) return { status: 'ambiguous', options };
  // Exact explicit secondary names remain usable, but do not mix matching dimensions.
  if (dimension === 'primary') {
    for (const f of ['department', 'team', 'group'] as const) {
      const hit = Object.values(dir).find(p => norm(p[f]) === n);
      if (hit) return { status: 'resolved', canonical: hit[f]!, fields: [f] };
    }
    // Compatibility for older snapshots containing only secondary columns.
    if (!values.size) {
      const legacy = resolveTeamAlias(dir, raw);
      if (legacy.status === 'resolved') return { ...legacy, fields: ['department', 'team', 'group'] };
      return legacy;
    }
  }
  return { status: 'unknown' };
}

/** Drop a leading "ทีม"/"แผนก"/"team" so "ทีมบัญชี" and "บัญชี" resolve identically. Thai is
 *  unspaced, so this is a prefix strip rather than a word removal. */
const stripLead = (s: string): string =>
  s.replace(/^(?:ทีม|แผนก|ฝ่าย|กลุ่ม|team|department|dept\.?)\s*/i, "").trim();

/** The registry columns that can name a team. */
const GROUPING_FIELDS = ["org", "subOrg", "group", "department", "team"] as const;

/** Every distinct team name the directory actually carries: normalized → as spelled. */
function registryValues(dir: ProfileMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of Object.values(dir)) {
    for (const f of GROUPING_FIELDS) {
      const v = p[f];
      if (!v) continue;
      const nv = norm(v);
      if (nv && !out.has(nv)) out.set(nv, v);
    }
  }
  return out;
}

export type AliasResolution =
  | { status: "resolved"; canonical: string }
  | { status: "ambiguous"; options: string[] }
  | { status: "unknown" };

/**
 * Map a team term the user typed onto the registry's own spelling, using the live
 * directory as the source of truth for what exists.
 *
 * `unknown` is not a failure: retrieval falls back to matching the raw text, which is
 * how every non-aliased team already works. Only `ambiguous` stops the answer.
 */
export function resolveTeamAlias(dir: ProfileMap, raw: string): AliasResolution {
  const n = stripLead(norm(raw));
  if (!n) return { status: "unknown" };

  // An exact registry name is never ambiguous — naming "Accounting" outright is how a
  // user answers the clarify question, so it must not loop back into it.
  const values = registryValues(dir);
  const exact = values.get(n);
  if (exact) return { status: "resolved", canonical: exact };

  const entry = ALIASES.find((a) => a.forms.includes(n));
  if (!entry) return { status: "unknown" };

  // Distinct registry values this concept actually covers, right now.
  const found = new Map<string, string>();
  for (const [nv, v] of values) {
    if (entry.match.test(nv)) found.set(nv, v);
  }

  const options = [...found.values()].sort((a, b) => a.localeCompare(b, "th"));
  if (options.length === 0) return { status: "unknown" };
  if (options.length === 1) return { status: "resolved", canonical: options[0] as string };
  return { status: "ambiguous", options };
}
