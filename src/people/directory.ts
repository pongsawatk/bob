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

const clean = (v: unknown): string => String(v ?? "").trim();

export interface ParsedDirectory {
  active: Record<string, Profile>;
  /** Emails listed below the "พนักงานลาออก" divider — ex-staff. */
  resigned: string[];
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
  const resigned: string[] = [];
  let inResigned = false;
  for (const r of rows.slice(headerIdx + 1)) {
    // The divider flips us into the resigned section; the repeated header row
    // right after it has no email so it's skipped naturally.
    if (r.some((c) => /ลาออก/.test(String(c ?? "")))) { inResigned = true; continue; }
    const email = clean(r[iEmail]).toLowerCase();
    if (!email.includes("@")) continue; // trailing/blank/section-header rows
    if (inResigned) { resigned.push(email); continue; }
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
  return { active, resigned };
}

// ── Refresh path (Graph → Redis) ───────────────────────────────────────

export interface DirectoryRefreshResult {
  people: number;
  refreshedAt: string;
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
  const { active, resigned } = parseRows(j.values ?? []);

  const people = Object.keys(active).length;
  // Same safety rule as refreshKB: never replace a good directory with an empty one.
  if (people === 0) throw new Error("refreshDirectory: parsed 0 people — refusing to overwrite");

  const r = getRedis();
  if (!r) throw new Error("Upstash Redis is not configured");
  await r.set(REDIS_KEY, active);
  await r.set(RESIGNED_KEY, resigned);
  mem = { map: active, at: Date.now() };
  return { people, refreshedAt: new Date().toISOString() };
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
