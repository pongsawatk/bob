// Proactive feature-announcement broadcast — personalized per recipient.
//
// Safety model (this is a mass DM; a mistake can't be recalled):
//  • Two phases. buildRoster() (run manually, no time limit) resolves every
//    stored conversation ref → email → nickname and freezes a roster in Redis.
//    runBroadcast() (cron or manual) reads that roster and sends, so the send
//    path makes zero Graph calls and finishes in one invocation.
//  • Idempotent per recipient: SETNX bob:bcast:{campaign}:sent:{aadId}. A cron
//    that re-fires, times out, or resumes never sends the same person twice.
//    A failed send releases its flag so it retries next run.
//  • Personalized greeting (nickname) only for people found in the HR directory;
//    everyone else gets a "fallback" variant that makes no "I know you" claim.
//  • Sending also stamps bob:introduced:{email} so the first-contact self-intro
//    (channels/teams.ts) never fires for someone who already got the announcement.

import { BotFrameworkAdapter, TurnContext, type Activity, type ConversationReference } from "botbuilder";
import { env } from "../env.js";
import { getRedis } from "../store/redis.js";
import { graphToken, lookupProfile, getResignedEmails } from "../people/directory.js";
import { fetchRetry } from "../http/fetchRetry.js";

export interface RosterEntry {
  aadId: string;
  email: string;
  name: string;
  nickname: string; // "" for fallback recipients
  variant: "matched" | "fallback";
}

const rosterKey = (c: string) => `bob:bcast:${c}:roster`;
const sentKey = (c: string, aadId: string) => `bob:bcast:${c}:sent:${aadId}`;
const introducedKey = (email: string) => `bob:introduced:${email}`;

// ── Message card (mirrors the proven welcome-card layout so Teams renders the
//    line breaks/bullets reliably — plain-text "\n" gets collapsed by Teams). ──

const EXAMPLES_MATCHED =
  '•  "คุณรู้จักผมไหม" — ดูว่าผมรู้อะไรเกี่ยวกับคุณบ้าง\n' +
  '•  "วันหยุดเหลือกี่วัน" — ตอบไวทันใจ\n' +
  '•  "สวัสดิการมีอะไรบ้าง" — ตอบครบ ดึงจากคลัง HR โดยตรง';

const EXAMPLES_FALLBACK =
  '•  "วันหยุดเหลือกี่วัน" — ตอบไวทันใจ\n' +
  '•  "สวัสดิการมีอะไรบ้าง" — ตอบครบ ดึงจากคลัง HR โดยตรง\n' +
  '•  "เบิกค่าทันตกรรมยังไง" — บอกสิทธิ์และขั้นตอนให้';

const FEEDBACK_LINE =
  "👍/👎 ใต้คำตอบช่วยผมเก่งขึ้นได้มากครับ — และถ้ามีเรื่องที่อยากให้ผมช่วยได้แต่ผมยังทำไม่ได้ พิมพ์ทิ้งไว้เลย ทีมงานอ่านเองสม่ำเสมอครับ";

function tb(text: string, extra: Record<string, unknown> = {}) {
  return { type: "TextBlock", wrap: true, text, ...extra };
}

export function buildBroadcastCard(entry: RosterEntry): Partial<Activity> {
  const body =
    entry.variant === "matched"
      ? [
          tb(`สวัสดีครับ**คุณ${entry.nickname}** 👋 ผม BOB เองครับ`),
          tb(
            "ที่เห็นว่าผมทักชื่อคุณถูก — นั่นแหละครับของใหม่ 😄 ตอนนี้ **ผมรู้จักคุณ** จาก " +
              "**ทะเบียนที่ทีม HR ดูแล** เลยพอรู้ว่าคุณอยู่ทีมไหน ตำแหน่งอะไร จะได้ช่วยตอบให้ตรงกับตัวคุณมากขึ้น " +
              "— และผมเห็น **เฉพาะข้อมูลของคนที่คุยกับผมเท่านั้น** ใครมาถามเรื่องคนอื่น ผมไม่บอกครับ 🔒",
            { spacing: "Small" }
          ),
          tb("ลองเล่นกับผมดูเลย 👇", { weight: "Bolder", spacing: "Medium" }),
          tb(EXAMPLES_MATCHED, { spacing: "Small" }),
          tb("เรื่องวันลา สวัสดิการ นโยบาย หรือเรื่องงานทั่วไป ทักมาได้ตลอดครับ", { spacing: "Medium" }),
          tb(FEEDBACK_LINE, { isSubtle: true, size: "Small", spacing: "Medium" }),
        ]
      : [
          tb("สวัสดีครับ 👋 ผม BOB (Builk One Buddy) ผู้ช่วย AI ของ Builk One Group ครับ"),
          tb(
            "ผมเพิ่งอัปเกรดตัวเองมาใหม่ — ตอบไวขึ้นและตอบได้ครบขึ้น โดยเฉพาะเรื่องสวัสดิการและนโยบาย " +
              "ที่ดึงจากคลังความรู้ที่ทีม HR ดูแลเองโดยตรงครับ",
            { spacing: "Small" }
          ),
          tb("ลองเล่นกับผมดูเลย 👇", { weight: "Bolder", spacing: "Medium" }),
          tb(EXAMPLES_FALLBACK, { spacing: "Small" }),
          tb("เรื่องวันลา สวัสดิการ นโยบาย หรือเรื่องงานทั่วไป ทักมาได้ตลอดครับ", { spacing: "Medium" }),
          tb(FEEDBACK_LINE, { isSubtle: true, size: "Small", spacing: "Medium" }),
        ];

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
        },
      },
    ],
  };
}

// ── Roster build (Graph → Redis) ───────────────────────────────────────

function looksRisky(nickname: string): string {
  if (!nickname) return "empty";
  if (/\d/.test(nickname)) return "has-digit";
  if (/\s/.test(nickname)) return "has-space";
  if (!/[฀-๿]/.test(nickname)) return "non-thai";
  return "";
}

export interface RosterSummary {
  campaign: string;
  total: number;
  matched: number;
  fallback: number;
  rows: Array<RosterEntry & { risk: string }>;
  excluded: Array<{ aadId: string; email: string; name: string; reason: string }>;
}

// A stored conversation ref does NOT mean "a current employee we should message".
// Drop resigned staff, shared/service mailboxes, and refs whose email can't be
// resolved (stale/bot ids) — reuse the same rules the provisioning script uses.
const EXCLUDE_NAME = /\[resign|\(shared\)|shared mailbox|do not use|ห้ามใช้|test account/i;
const EXCLUDE_LOCAL = new Set([
  "acc", "accba", "account", "admin", "application", "info", "support",
  "noreply", "no-reply", "test", "notification", "notifications", "prod_ploy",
]);

/** Reason to skip a ref entirely (never message), or "" to keep it. */
function excludeReason(email: string, name: string, resigned: Set<string>): string {
  if (!email || !email.includes("@")) return "no-email"; // unresolved / bot / stale ref
  if (resigned.has(email)) return "resigned-directory"; // listed in the sheet's resigned section
  if (EXCLUDE_NAME.test(name)) return "resigned/shared";
  if (EXCLUDE_LOCAL.has(email.split("@")[0] ?? "")) return "service-account";
  return "";
}

async function resolveEmail(token: string, aadId: string): Promise<{ email: string; name: string }> {
  const res = await fetchRetry(
    `https://graph.microsoft.com/v1.0/users/${aadId}?$select=mail,userPrincipalName,displayName`,
    { headers: { Authorization: `Bearer ${token}` } },
    { retries: 1, timeoutMs: 10_000 }
  );
  if (!res.ok) return { email: "", name: "" };
  const j = (await res.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
  return { email: (j.mail ?? j.userPrincipalName ?? "").toLowerCase(), name: j.displayName ?? "" };
}

/** Resolve every stored conversation ref → email → nickname and freeze the
 *  roster in Redis. Safe to re-run (overwrites the roster; never sends). */
export async function buildRoster(campaign: string): Promise<RosterSummary> {
  const r = getRedis();
  if (!r) throw new Error("Redis not configured");
  const keys = await r.keys("bob:convref:*");
  const token = await graphToken();
  const resigned = await getResignedEmails();

  const rows: Array<RosterEntry & { risk: string }> = [];
  const excluded: RosterSummary["excluded"] = [];
  for (const k of keys) {
    const aadId = k.replace("bob:convref:", "");
    const { email, name } = await resolveEmail(token, aadId);
    const reason = excludeReason(email, name, resigned);
    if (reason) { excluded.push({ aadId, email, name, reason }); continue; }
    const profile = await lookupProfile(email);
    const nickname = profile?.nickname ?? "";
    const variant: RosterEntry["variant"] = nickname ? "matched" : "fallback";
    rows.push({ aadId, email, name, nickname, variant, risk: variant === "matched" ? looksRisky(nickname) : "" });
  }

  const roster: RosterEntry[] = rows.map(({ risk, ...e }) => e);
  await r.set(rosterKey(campaign), roster);

  return {
    campaign,
    total: rows.length,
    matched: rows.filter((x) => x.variant === "matched").length,
    fallback: rows.filter((x) => x.variant === "fallback").length,
    rows,
    excluded,
  };
}

// ── Send (Redis roster → Bot Framework DMs), idempotent + concurrent ────

let _adapter: BotFrameworkAdapter | null = null;
function adapter(): BotFrameworkAdapter {
  if (!_adapter) {
    _adapter = new BotFrameworkAdapter({
      appId: env.AZURE_BOT_ID || undefined,
      appPassword: env.AZURE_BOT_SECRET || undefined,
      channelAuthTenant: env.AZURE_TENANT_ID || undefined,
    });
  }
  return _adapter;
}

export interface BroadcastResult {
  campaign: string;
  attempted: number;
  sent: number;
  skipped: number; // already sent in a previous run
  failed: number;
  dryRun: boolean;
}

/**
 * Send the campaign to everyone in its roster who hasn't received it yet.
 * Idempotent (SETNX per recipient), concurrency-limited, resumable. dryRun
 * counts what would send and renders nothing.
 */
export async function runBroadcast(
  campaign: string,
  opts: { dryRun?: boolean; concurrency?: number } = {}
): Promise<BroadcastResult> {
  const { dryRun = false, concurrency = 8 } = opts;
  const r = getRedis();
  if (!r) throw new Error("Redis not configured");
  const roster = (await r.get<RosterEntry[]>(rosterKey(campaign))) ?? [];

  const res: BroadcastResult = { campaign, attempted: 0, sent: 0, skipped: 0, failed: 0, dryRun };

  const sendOne = async (entry: RosterEntry): Promise<void> => {
    res.attempted++;
    // Claim this recipient. NX returns null when the key already exists (sent).
    if (!dryRun) {
      const claimed = await r.set(sentKey(campaign, entry.aadId), 1, { nx: true });
      if (claimed === null) { res.skipped++; return; }
    }
    if (dryRun) return; // counted as attempted; nothing sent

    const ref = await r.get<Partial<ConversationReference>>(`bob:convref:${entry.aadId}`);
    if (!ref) { await r.del(sentKey(campaign, entry.aadId)); res.failed++; return; }

    try {
      const card = buildBroadcastCard(entry);
      await adapter().continueConversation(ref as ConversationReference, async (ctx: TurnContext) => {
        await ctx.sendActivity(card);
      });
      // Suppress the first-contact self-intro for anyone who got the announcement.
      if (entry.email) await r.set(introducedKey(entry.email), 1);
      res.sent++;
    } catch (err) {
      console.error(`broadcast: send failed for ${entry.aadId}:`, err);
      await r.del(sentKey(campaign, entry.aadId)); // release so it retries next run
      res.failed++;
    }
  };

  // Simple concurrency pool.
  for (let i = 0; i < roster.length; i += concurrency) {
    await Promise.all(roster.slice(i, i + concurrency).map(sendOne));
  }
  return res;
}
