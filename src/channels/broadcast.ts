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

// Examples are the green-lit set only — capabilities verified against code +
// Langfuse traces. Deliberately NOT here: personal leave balance (HumanSoft, we
// can't read it), ลาพักร้อน entitlement + ทันตกรรม/ประกันกลุ่ม (known KB gaps),
// and bare "วันหยุดเหลือกี่วัน" (ambiguous — the old card trained people to ask
// leave balance, which then hit the HumanSoft wall → day-0 churn).
const EXAMPLES_MATCHED =
  '•  "หัวหน้าฉันคือใคร"\n' +
  '•  "ฉันทำงานที่นี่มากี่ปีแล้ว"\n' +
  '•  "ทีม ConTech มีใครบ้าง" — ถามหาคน/ทีมอื่นก็ได้ครับ';

const HR_GOOD =
  '•  "เดือนนี้บริษัทหยุดวันไหนบ้าง" — ตอบทันที\n' +
  '•  "สวัสดิการพนักงานมีอะไรบ้าง"\n' +
  '•  "ลาแต่ละประเภทมีเงื่อนไขยังไง"';

const EXAMPLES_FALLBACK =
  HR_GOOD + '\n•  "หัวหน้าของ [ชื่อ] คือใคร" / "ทีม ConTech มีใครบ้าง"';

// The #1 thing people asked in round one — name it plainly instead of letting
// them hit the wall themselves, then pivot to what we CAN answer.
const HUMANSOFT_LINE =
  'คำที่หลายคนถามกันเยอะสุดคือ *"วันลาของฉันเหลือกี่วัน"* — ยอดคงเหลือส่วนตัวอยู่ในระบบ ' +
  "**HumanSoft** ที่ตอนนี้ผมยังเข้าไม่ถึงครับ เช็กได้ที่แอป/เว็บ HumanSoft โดยตรง " +
  "แต่ถ้าถามเรื่อง **วันหยุดบริษัท** หรือ **สิทธิ์/เงื่อนไขการลาตามระเบียบ** ถามผมได้เต็มที่เลยครับ";

const FEEDBACK_LINE =
  "👍/👎 ใต้คำตอบช่วยผมเก่งขึ้นได้มากครับ — และถ้ามีเรื่องที่อยากให้ผมช่วยได้แต่ผมยังทำไม่ได้ พิมพ์ทิ้งไว้เลย ทีมงานอ่านเองสม่ำเสมอครับ";

function tb(text: string, extra: Record<string, unknown> = {}) {
  return { type: "TextBlock", wrap: true, text, ...extra };
}

export function buildBroadcastCard(entry: RosterEntry): Partial<Activity> {
  const body =
    entry.variant === "matched"
      ? [
          tb("**มีของใหม่มาบอกครับ** ✨"),
          tb(`สวัสดีครับ **คุณ${entry.nickname}** 👋 ผม BOB เองนะครับ`, { spacing: "Small" }),
          tb(
            "จากนี้คุยกับผม **ไม่ต้องเล่าตัวเองซ้ำแล้ว** — ผมพอรู้ว่าคุณอยู่ทีมไหน ตำแหน่งอะไร " +
              "ทำงานมานานแค่ไหน หัวหน้าคือใคร (จาก **ทะเบียนที่ทีม HR ดูแล**) เลยช่วยตอบให้ " +
              "**ตรงกับตัวคุณ** ได้มากขึ้นครับ",
            { spacing: "Small" }
          ),
          tb("ลองทักผมแบบนี้ดูครับ 👇", { weight: "Bolder", spacing: "Medium" }),
          tb(EXAMPLES_MATCHED, { spacing: "Small" }),
          tb("**เรื่อง HR ที่ผมตอบได้แม่น** 💚", { spacing: "Medium" }),
          tb(HR_GOOD, { spacing: "Small" }),
          tb("**ขอบอกให้ชัดสักเรื่อง** 🙏", { spacing: "Medium" }),
          tb(HUMANSOFT_LINE, { spacing: "Small" }),
          tb('ลองเริ่มเลยไหมครับ 👉 *"หัวหน้าฉันคือใคร"*', { weight: "Bolder", spacing: "Medium" }),
          tb(FEEDBACK_LINE, { isSubtle: true, size: "Small", spacing: "Medium" }),
        ]
      : [
          tb("**BOB มีอะไรใหม่มาเล่าครับ** ✨"),
          tb(
            "สวัสดีครับ 👋 ผม BOB (Builk One Buddy) ผู้ช่วย AI ของ Builk One Group ครับ " +
              "จากคำถามที่หลายคนส่งเข้ามา ผมมีบางเรื่องอยากบอกให้ชัด จะได้ใช้ผมได้คุ้มขึ้นครับ",
            { spacing: "Small" }
          ),
          tb("**เรื่อง HR ที่ผมตอบได้แม่น** 💚", { weight: "Bolder", spacing: "Medium" }),
          tb(EXAMPLES_FALLBACK, { spacing: "Small" }),
          tb("**ขอบอกให้ชัดสักเรื่อง** 🙏", { spacing: "Medium" }),
          tb(HUMANSOFT_LINE, { spacing: "Small" }),
          tb("ลองทักมาได้ทุกเมื่อครับ 😊", { spacing: "Medium" }),
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
