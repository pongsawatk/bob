// Employee directory: SharePoint "BOG ทะเบียนพนักงาน For All.xlsx" → Redis.
// Mirrors the KB pattern (kb/index.ts): the request path reads memory → Redis
// only; refreshDirectory() (piggybacked on /refresh) is the only thing that
// talks to Microsoft Graph. The directory NEVER enters the shared KB bundle —
// per-request we inject only the asker's own profile (see renderProfileBlock).
//
// Graph auth reuses the bot's App Registration (client credentials). The app
// needs Sites.Read.All (Application) + admin consent — granted 2026-07-05.

import { env } from "../env.js";
import { fetchRetry } from "../http/fetchRetry.js";
import { getRedis } from "../store/redis.js";

export interface Profile {
  email: string;
  nickname?: string;
  fullNameTh: string;
  fullNameEn?: string;
  position?: string;
  org?: string;
  /** "Sub Org" column — finer than Org; often where the real team name lives. */
  subOrg?: string;
  /** "Group" column — another grouping used for team lookups. */
  group?: string;
  department?: string;
  team?: string;
  rank?: string;
  /** ISO date (converted from Thai Buddhist year in the sheet). */
  startDate?: string;
  supervisor?: string;
  /** G0 columns HR adds to the sheet. employmentType = employment status;
   *  ownershipTags = product/thing this person officially owns (comma/newline
   *  separated in the cell). Both undefined until the column exists + is filled. */
  employmentType?: string;
  ownershipTags?: string[];
}

/** Split a tag cell (comma / semicolon / newline / Thai comma) into clean tags. */
function splitTags(v: unknown): string[] | undefined {
  const parts = String(v ?? "")
    .split(/[,;\n、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

const REDIS_KEY = "bob:directory";
const RESIGNED_KEY = "bob:directory:resigned";
const MEM_TTL_MS = 60_000;

let mem: { map: Record<string, Profile>; at: number } | null = null;

// ── Graph auth (client credentials, token cached until ~5 min before expiry) ──

let tok: { value: string; expiresAt: number } | null = null;

export async function graphToken(): Promise<string> {
  if (tok && Date.now() < tok.expiresAt - 300_000) return tok.value;
  const body = new URLSearchParams({
    client_id: env.AZURE_BOT_ID,
    client_secret: env.AZURE_BOT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetchRetry(
    `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body },
    { retries: 2, timeoutMs: 10_000 }
  );
  if (!res.ok) throw new Error(`Graph token HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Graph token response missing access_token");
  tok = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tok.value;
}

// ── Sheet parsing ──────────────────────────────────────────────────────

/**
 * Start dates arrive either as text "17/05/2548" (dd/mm/yyyy, Thai Buddhist
 * year) or as an Excel serial number (workbook usedRange returns raw cell
 * values). Both may carry a BE year (HR types พ.ศ.), so normalize year > 2400
 * by −543 in both paths. → "2005-05-17".
 */
function parseThaiDate(v: unknown): string | undefined {
  if (typeof v === "number" && v > 20000) {
    // Excel serial (days since 1899-12-30) → UTC date parts.
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    let year = d.getUTCFullYear();
    if (year > 2400) year -= 543;
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, dd = "", mm = "", yyyy = ""] = m;
  let year = Number(yyyy);
  if (year > 2400) year -= 543;
  return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Full-width ASCII (U+FF01–FF5E) → ASCII, plus the ideographic space. */
const foldWidth = (s: string): string =>
  s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");

/**
 * Normalize a sheet cell (WP-04). HR types into Excel, so cells arrive with
 * non-breaking spaces (pasted out of Word/Teams), doubled spaces, and occasionally
 * full-width Latin. Those are invisible on screen but make exact-normalized matching
 * miss, which reads to a user as "BOB does not know my team".
 *
 * NFC, deliberately NOT NFKC. NFKC compatibility decompositions break Thai: it splits
 * SARA AM (U+0E33) into NIKHAHIT + SARA AA, so "ตำแหน่ง" stops matching the literal
 * "ตำแหน่ง" in the column regexes below — the position column would silently vanish from
 * every profile, taking the WP-02 role filter down with it. Width folding is done
 * explicitly instead: it is the only part of NFKC we actually wanted.
 */
const clean = (v: unknown): string =>
  foldWidth(String(v ?? "").normalize("NFC"))
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Bump when the stored Profile shape changes, so a snapshot written by an older
 *  deploy can be recognized rather than misread. */
export const DIRECTORY_SCHEMA_VERSION = "2";

/** A profile whose Supervisor cell names nobody we can resolve. */
export interface UnresolvedSupervisor {
  email: string;
  raw: string;
}

export interface ParsedDirectory {
  active: Record<string, Profile>;
  /** Emails listed below the "พนักงานลาออก" divider — ex-staff. Never includes a
   *  re-hire: an email that also has an active row is current staff (see parseRows). */
  resigned: string[];
  /** Addresses seen more than once WITHIN a section. `active` is keyed by email, so
   *  a duplicate silently collapses two people into the last row written — and a
   *  self-identity answer would then be about the wrong person. Surfaced so identity
   *  resolution can refuse instead of guessing. An email in both sections is NOT a
   *  duplicate — that's a re-hire (old stint kept below the divider as history). */
  duplicateEmails: string[];
  /** Supervisor cells that resolve to nobody — reported, never guessed. */
  unresolvedSupervisors: UnresolvedSupervisor[];
  /** Human-readable data-quality notes for the refresh caller. */
  warnings: string[];
}

/** Parse usedRange rows: locate the header row by its "Email" cell (the sheet
 *  has a title row above it), then map each data row to a Profile.
 *
 *  The sheet keeps RESIGNED staff below an "พนักงานลาออก" divider (with a repeated
 *  header). Those rows still carry emails, so we split them out: `active` never
 *  includes ex-staff (BOB won't greet them as current), and `resigned` is exported
 *  so the broadcast can exclude them even when their AAD display name isn't tagged. */
export function parseRows(rows: unknown[][]): ParsedDirectory {
  const headerIdx = rows.findIndex((r) => r.some((c) => /^\s*email\s*$/i.test(String(c ?? ""))));
  if (headerIdx === -1) throw new Error("directory: header row with 'Email' column not found");
  const header = (rows[headerIdx] ?? []).map((c) => clean(c));
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));

  const iEmail = col(/^email$/i);
  const iFirstTh = col(/^ชื่อ$/);
  const iLastTh = col(/^นามสกุล$/);
  const iFirstEn = col(/^name$/i);
  const iLastEn = col(/^surname$/i);
  const iNick = col(/ชื่อเล่น/);
  const iPos = col(/ตำแหน่ง/);
  const iOrg = col(/^org$/i);
  const iSubOrg = col(/^sub\s*[- ]?\s*org$/i);
  const iGroup = col(/^group$/i);
  const iDept = col(/corporate department/i);
  const iTeam = col(/function/i);
  const iRank = col(/^rank$/i);
  const iStart = col(/วันที่เริ่ม/);
  const iSup = col(/supervisor/i);
  const iEmpType = col(/สถานะการจ้าง|employment/i); // G0 column (HR)
  const iOwn = col(/ownership|product\s*owner|ผู้รับผิดชอบ|รับผิดชอบ|ดูแลผลิตภัณฑ์/i); // G0 column (HR)

  const active: Record<string, Profile> = {};
  const resignedSeen = new Set<string>();
  const dupes = new Set<string>();
  let inResigned = false;
  for (const r of rows.slice(headerIdx + 1)) {
    const email = clean(r[iEmail]).toLowerCase();
    const isDataRow = email.includes("@");
    // The divider flips us into the resigned section; the repeated header row right
    // after it has no email so it's skipped naturally. Only a row with NO email can be
    // a divider: matching "ลาออก" anywhere in any cell would make one person's position
    // or note ("เจ้าหน้าที่ดูแลการลาออก") silently move them — and everyone below them — into
    // the resigned section, dropping them from the directory with no error.
    if (!isDataRow && r.some((c) => /ลาออก/.test(String(c ?? "")))) { inResigned = true; continue; }
    if (!isDataRow) continue; // trailing/blank/section-header rows
    if (inResigned) {
      if (resignedSeen.has(email)) dupes.add(email);
      resignedSeen.add(email);
      continue;
    }
    if (active[email]) dupes.add(email);
    active[email] = {
      email,
      fullNameTh: [clean(r[iFirstTh]), clean(r[iLastTh])].filter(Boolean).join(" "),
      fullNameEn: [clean(r[iFirstEn]), clean(r[iLastEn])].filter(Boolean).join(" ") || undefined,
      nickname: clean(r[iNick]) || undefined,
      position: clean(r[iPos]) || undefined,
      org: clean(r[iOrg]) || undefined,
      subOrg: iSubOrg >= 0 ? clean(r[iSubOrg]) || undefined : undefined,
      group: iGroup >= 0 ? clean(r[iGroup]) || undefined : undefined,
      department: clean(r[iDept]) || undefined,
      team: clean(r[iTeam]) || undefined,
      rank: clean(r[iRank]) || undefined,
      startDate: parseThaiDate(r[iStart]),
      supervisor: clean(r[iSup]) || undefined,
      employmentType: iEmpType >= 0 ? clean(r[iEmpType]) || undefined : undefined,
      ownershipTags: iOwn >= 0 ? splitTags(r[iOwn]) : undefined,
    };
  }

  // Re-hires: HR keeps the old employment stint below the ลาออก divider as history,
  // then adds a fresh row on top when the person returns. The active row is the
  // current truth, so they must NOT land in the resigned projection (it would drop
  // them from broadcasts and mark them ex-staff). Surfaced as a warning, not an error.
  const rehired = [...resignedSeen].filter((e) => active[e]).sort();
  const resigned = [...resignedSeen].filter((e) => !active[e]);

  const duplicateEmails = [...dupes].sort();
  const unresolvedSupervisors = validateSupervisors(active);
  const warnings: string[] = [];
  for (const e of rehired) warnings.push(`re-hired (row in both sections, active row wins): ${e}`);
  for (const e of duplicateEmails) warnings.push(`duplicate email in the sheet: ${e}`);
  if (unresolvedSupervisors.length) {
    warnings.push(`${unresolvedSupervisors.length} profile(s) name a supervisor that resolves to nobody`);
  }
  return { active, resigned, duplicateEmails, unresolvedSupervisors, warnings };
}

/** Which Supervisor cells point at nobody. The cell is free text (an email or a full
 *  name), so resolve it the same way retrieval does — by email, then by exactly one
 *  normalized name match. Anything else is reported, never guessed at. */
function validateSupervisors(active: Record<string, Profile>): UnresolvedSupervisor[] {
  const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  const out: UnresolvedSupervisor[] = [];
  const people = Object.values(active);
  for (const p of people) {
    const raw = (p.supervisor ?? "").trim();
    if (!raw) continue; // top of the org / not filled in — not an error
    if (active[raw.toLowerCase()]) continue;
    const n = norm(raw);
    const hits = people.filter((q) => norm(q.fullNameTh) === n || (q.fullNameEn ? norm(q.fullNameEn) === n : false));
    if (hits.length !== 1 || hits[0]?.email === p.email) out.push({ email: p.email, raw });
  }
  return out;
}

// ── Refresh path (Graph → Redis) ───────────────────────────────────────

export interface DirectoryRefreshResult {
  people: number;
  refreshedAt: string;
  warnings: string[];
}

/** Freshness + provenance for the published snapshot (WP-04). Answers cite
 *  `sourceUpdatedAt` so a user can judge staleness themselves — the sheet is edited on
 *  HR's schedule, so a new joiner can legitimately be missing. */
export interface DirectoryMeta {
  /** when the source workbook was last edited (Graph lastModifiedDateTime). */
  sourceUpdatedAt?: string;
  /** when we last pulled it. */
  lastSyncedAt: string;
  schemaVersion: string;
  people: number;
  warnings: string[];
}

const META_KEY = "bob:directory:meta";

/** Largest share of the roster a single refresh may drop before we refuse it. A real
 *  sheet does not lose a third of the company overnight; a truncated export, a renamed
 *  sheet, or a half-saved file does. Relative on purpose — a hard-coded expected
 *  headcount would go stale the first time HR hires. */
const MAX_SHRINK = 0.33;

/** Source workbook's last-modified time. Best-effort: freshness is a nicety, so a
 *  failure here must not block a refresh that otherwise parsed cleanly. */
async function fetchSourceUpdatedAt(token: string): Promise<string | undefined> {
  try {
    const res = await fetchRetry(
      `https://graph.microsoft.com/v1.0/drives/${env.DIRECTORY_DRIVE_ID}/items/${env.DIRECTORY_ITEM_ID}?$select=lastModifiedDateTime`,
      { headers: { Authorization: `Bearer ${token}` } },
      { retries: 1, timeoutMs: 10_000 },
    );
    if (!res.ok) return undefined;
    const j = (await res.json()) as { lastModifiedDateTime?: string };
    return j.lastModifiedDateTime;
  } catch {
    return undefined;
  }
}

/** Published snapshot freshness, for the answer footer. */
export async function getDirectoryMeta(): Promise<DirectoryMeta | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<DirectoryMeta>(META_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function refreshDirectory(): Promise<DirectoryRefreshResult> {
  const token = await graphToken();
  const url =
    `https://graph.microsoft.com/v1.0/drives/${env.DIRECTORY_DRIVE_ID}` +
    `/items/${env.DIRECTORY_ITEM_ID}/workbook/worksheets` +
    `/${encodeURIComponent(env.DIRECTORY_SHEET)}/usedRange?$select=values`;
  const res = await fetchRetry(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    { retries: 2, timeoutMs: 30_000 }
  );
  if (!res.ok) throw new Error(`Graph usedRange HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { values?: unknown[][] };
  const parsed = parseRows(j.values ?? []);
  const { active, resigned, warnings } = parsed;

  const people = Object.keys(active).length;
  // Same safety rule as refreshKB: never replace a good directory with an empty one.
  if (people === 0) throw new Error("refreshDirectory: parsed 0 people — refusing to overwrite");

  // Validate the whole snapshot BEFORE anything is published — a half-valid directory
  // must never be visible to a request (WP-04 atomic publish).
  const leaked = resigned.filter((e) => active[e]);
  if (leaked.length > 0) {
    throw new Error(
      `refreshDirectory: ${leaked.length} resigned email(s) also present in the active projection — refusing to publish`,
    );
  }

  const r = getRedis();
  if (!r) throw new Error("Upstash Redis is not configured");

  const prev = await r.get<Record<string, Profile>>(REDIS_KEY);
  const prevCount = prev ? Object.keys(prev).length : 0;
  if (prevCount > 0 && people < prevCount * (1 - MAX_SHRINK)) {
    throw new Error(
      `refreshDirectory: parsed ${people} people vs ${prevCount} currently published ` +
        `(>${Math.round(MAX_SHRINK * 100)}% drop) — refusing to publish, check the source sheet`,
    );
  }

  const meta: DirectoryMeta = {
    sourceUpdatedAt: await fetchSourceUpdatedAt(token),
    lastSyncedAt: new Date().toISOString(),
    schemaVersion: DIRECTORY_SCHEMA_VERSION,
    people,
    warnings,
  };

  await r.set(REDIS_KEY, active);
  await r.set(RESIGNED_KEY, resigned);
  await r.set(META_KEY, meta);
  mem = { map: active, at: Date.now() };
  // Data-quality notes are surfaced to the admin running /refresh rather than thrown:
  // a duplicated email or an unresolvable supervisor is HR's to fix, and refusing the
  // whole directory over one bad cell would be worse than serving it with a warning.
  if (warnings.length) console.warn(`refreshDirectory warnings: ${warnings.join(" · ")}`);
  return { people, refreshedAt: meta.lastSyncedAt, warnings };
}

/** Emails in the sheet's "พนักงานลาออก" section — for excluding ex-staff from
 *  broadcasts even when their AAD display name isn't tagged [Resign]. */
export async function getResignedEmails(): Promise<Set<string>> {
  const r = getRedis();
  if (!r) return new Set();
  const list = (await r.get<string[]>(RESIGNED_KEY)) ?? [];
  return new Set(list.map((e) => e.toLowerCase()));
}

// ── Request path (memory → Redis; never Graph) ─────────────────────────

export async function lookupProfile(email: string): Promise<Profile | null> {
  if (!email) return null;
  if (!mem || Date.now() - mem.at >= MEM_TTL_MS) {
    const r = getRedis();
    if (!r) return null;
    try {
      const map = await r.get<Record<string, Profile>>(REDIS_KEY);
      if (!map) return null;
      mem = { map, at: Date.now() };
    } catch (err) {
      console.error("lookupProfile: redis read failed:", err);
      return mem?.map[email.toLowerCase()] ?? null; // stale memory beats nothing
    }
  }
  return mem.map[email.toLowerCase()] ?? null;
}

/** Every name + nickname in the directory — used to mask employee names in analytics
 *  samples (redaction). Deduped, non-empty, length >= 2 (so short initials don't over-mask). */
export function namesFromProfiles(map: Record<string, Profile>): string[] {
  const names = new Set<string>();
  for (const p of Object.values(map)) {
    for (const n of [p.fullNameTh, p.fullNameEn, p.nickname]) {
      const v = (n ?? "").trim();
      if (v.length >= 2) names.add(v);
    }
  }
  return [...names];
}

/** Full active-profile map (memory → Redis, never Graph) — for People Connector
 *  cross-person retrieval (profileStore). Same read path as getDirectoryNames;
 *  returns {} when the directory hasn't been loaded so callers degrade to empty. */
export async function getActiveDirectory(): Promise<Record<string, Profile>> {
  if (!mem || Date.now() - mem.at >= MEM_TTL_MS) {
    const r = getRedis();
    if (r) {
      try {
        const map = await r.get<Record<string, Profile>>(REDIS_KEY);
        if (map) mem = { map, at: Date.now() };
      } catch (err) {
        console.error("getActiveDirectory: redis read failed:", err);
      }
    }
  }
  return mem ? mem.map : {};
}

/** Directory names for redaction. Reads memory → Redis (never Graph), like lookupProfile. */
export async function getDirectoryNames(): Promise<string[]> {
  if (!mem || Date.now() - mem.at >= MEM_TTL_MS) {
    const r = getRedis();
    if (r) {
      try {
        const map = await r.get<Record<string, Profile>>(REDIS_KEY);
        if (map) mem = { map, at: Date.now() };
      } catch (err) {
        console.error("getDirectoryNames: redis read failed:", err);
      }
    }
  }
  return mem ? namesFromProfiles(mem.map) : [];
}

/** Thai tenure string from an ISO start date, e.g. "21 ปี 1 เดือน". */
function tenureTh(startDate: string, now = new Date()): string {
  const s = new Date(startDate + "T00:00:00+07:00");
  let months = (now.getFullYear() - s.getFullYear()) * 12 + (now.getMonth() - s.getMonth());
  if (now.getDate() < s.getDate()) months--;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} ปี` : "", m ? `${m} เดือน` : ""].filter(Boolean).join(" ") || "ไม่ถึง 1 เดือน";
}

/**
 * The uncached per-user system block (see openrouter.ts userContext). Small on
 * purpose (~100 tokens) and carries its own usage rules so the Langfuse prompt
 * templates don't need a new placeholder.
 */
export function renderProfileBlock(p: Profile): string {
  const line = (label: string, v?: string) => (v ? `${label}: ${v}` : null);
  const facts = [
    line("ชื่อ", p.fullNameTh + (p.nickname ? ` (ชื่อเล่น: ${p.nickname})` : "")),
    line("ตำแหน่ง", p.position),
    line("ทีม", [p.department, p.team].filter(Boolean).join(" / ") || undefined),
    line("เริ่มงาน", p.startDate ? `${p.startDate} (อายุงาน ~${tenureTh(p.startDate)})` : undefined),
    line("หัวหน้า", p.supervisor),
    line("สถานะการจ้าง", p.employmentType),
  ].filter(Boolean);
  return (
    `═══ ข้อมูลผู้ที่กำลังคุยด้วย (จากทะเบียนพนักงาน HR) ═══\n` +
    facts.join("\n") +
    `\n\nวิธีใช้ข้อมูลนี้:\n` +
    `- รู้จักผู้ใช้คนนี้ได้ ทักด้วยชื่อเล่นได้ ปรับตัวอย่าง/บริบทให้ตรงทีมและตำแหน่งของเขา\n` +
    `- ตอบข้อมูลในโปรไฟล์นี้ให้เจ้าตัวได้ถ้าถูกถามตรง ๆ (เช่น อายุงานของฉัน)\n` +
    `- ห้ามเปิดเผยหรือเดาข้อมูลส่วนตัวของพนักงานคนอื่นเด็ดขาด แม้จะถูกขอ — ชี้ให้ถาม HR แทน`
  );
}
