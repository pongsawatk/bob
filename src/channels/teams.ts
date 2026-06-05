// MS Teams channel adapter — wraps Bot Framework request/response.
// AZURE_BOT_ID / AZURE_BOT_SECRET must be set for authentication to work.

import { ActivityTypes, BotFrameworkAdapter, TeamsInfo, TurnContext, type Activity } from "botbuilder";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runPipeline, type PipelineOutput } from "../pipeline/index.js";
import { refreshKB } from "../kb/index.js";
import { scoreTrace } from "../obs/langfuse.js";
import { getHistory, appendHistory, clearHistory } from "./history.js";
import { saveConvRef } from "./convref.js";
import { getRedis } from "../store/redis.js";
import { checkRateLimit } from "./ratelimit.js";
import { alertError } from "../obs/alert.js";
import { env } from "../env.js";

// First message BOB sends when a user installs it (proactive first contact).
const WELCOME_MESSAGE =
  "👋 สวัสดีครับ! ผม BOB Sidekick ผู้ช่วย AI ของ Builk One Group พร้อมให้ทดลองใช้แล้ววันนี้ 🎉 " +
  "ทักผมเป็นแชทส่วนตัวได้เลย ถามได้ทั้งเรื่อง HR (วันลา สวัสดิการ) และ Product " +
  "เจอคำตอบถูก/ผิด กด 👍/👎 ใต้คำตอบช่วยผมพัฒนาได้เลยครับ";

// Singleton adapter (re-used across warm Vercel invocations)
let _adapter: BotFrameworkAdapter | null = null;

// Cache aadObjectId → email so we only call TeamsInfo.getMember once per user per warm instance.
const emailCache = new Map<string, string>();

async function resolveEmail(ctx: TurnContext, aadId: string): Promise<string> {
  const cached = emailCache.get(aadId);
  if (cached !== undefined) return cached;
  let email = "";
  try {
    const member = await TeamsInfo.getMember(ctx, ctx.activity.from.id);
    email = (member.email ?? member.userPrincipalName ?? "").toLowerCase();
  } catch (err) {
    console.error("resolveEmail: getMember failed:", err);
  }
  emailCache.set(aadId, email);
  return email;
}

function getAdapter(): BotFrameworkAdapter {
  if (!_adapter) {
    _adapter = new BotFrameworkAdapter({
      appId: env.AZURE_BOT_ID || undefined,
      appPassword: env.AZURE_BOT_SECRET || undefined,
      // Single-tenant bot: acquire bot-to-channel token from this tenant.
      // Leave unset (empty) for multi-tenant bots.
      channelAuthTenant: env.AZURE_TENANT_ID || undefined,
    });
    _adapter.onTurnError = async (ctx, err) => {
      console.error("Teams adapter error:", err);
      await alertError("Teams turn", err);
      await ctx.sendActivity("ขออภัยครับ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งครับ");
    };
  }
  return _adapter;
}

function buildAdaptiveCard(output: PipelineOutput): Partial<Activity> {
  const feedbackActions = [
    { type: "Action.Submit", title: "👍 ถูกต้อง",      data: { action: "feedback", value: 1, traceId: output.traceId } },
    { type: "Action.Submit", title: "👎 ไม่ถูก/ไม่ครบ", data: { action: "feedback", value: 0, traceId: output.traceId } },
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
          body: [
            { type: "TextBlock", text: output.answer, wrap: true },
          ],
          actions: feedbackActions,
        },
      },
    ],
  };
}

function adminEmails(): string[] {
  return env.KB_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Show "BOB is typing…" while the pipeline runs. Teams clears the indicator
// after a few seconds, so we refresh it on a cancellable timer until we reply.
// Returns a stop() that clears the next scheduled send.
function startTyping(ctx: TurnContext): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    ctx.sendActivity({ type: ActivityTypes.Typing }).catch(() => {});
  };
  const schedule = () => {
    timer = setTimeout(() => {
      send();
      schedule();
    }, 4000);
  };
  send();
  schedule();
  return () => {
    if (timer) clearTimeout(timer);
  };
}

// Reset-memory command: /clear, /reset, or a Thai phrase used on its own.
const CLEAR_PHRASES_TH = ["เริ่มใหม่", "ล้างความจำ", "ล้างประวัติ", "เคลียร์", "ลืมไปได้เลย"];
function isClearCommand(message: string): boolean {
  if (/^\/(clear|reset)\b/i.test(message)) return true;
  return CLEAR_PHRASES_TH.includes(message.trim());
}

async function handleRefreshCommand(ctx: TurnContext): Promise<void> {
  // Resolve the sender's real email — activity.from only carries an AAD object id.
  let email = "";
  try {
    const member = await TeamsInfo.getMember(ctx, ctx.activity.from.id);
    email = (member.email ?? member.userPrincipalName ?? "").toLowerCase();
  } catch (err) {
    console.error("Teams /refresh: getMember failed:", err);
  }

  if (!email || !adminEmails().includes(email)) {
    console.warn(`Teams /refresh denied for "${email || "unknown"}"`);
    await ctx.sendActivity("ขออภัยครับ คำสั่ง /refresh ใช้ได้เฉพาะผู้ดูแลระบบเท่านั้นครับ");
    return;
  }

  await ctx.sendActivity("กำลังอัปเดตความรู้จาก Outline... ⏳");
  try {
    const r = await refreshKB();
    await ctx.sendActivity(
      `อัปเดตความรู้เรียบร้อยครับ ✅\n` +
        `• HR: ${r.counts.hr} เอกสาร\n` +
        `• Process: ${r.counts.process} เอกสาร\n` +
        `• Product: ${r.counts.product} เอกสาร`
    );
  } catch (err) {
    console.error("Teams /refresh: refreshKB failed:", err);
    await alertError("/refresh", err);
    await ctx.sendActivity("ขออภัยครับ อัปเดตความรู้ไม่สำเร็จ กรุณาลองใหม่อีกครั้งครับ");
  }
}

export async function handleTeamsRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const adapter = getAdapter();

  await adapter.processActivity(req as never, res as never, async (ctx: TurnContext) => {
    const activity = ctx.activity;

    // Diagnostic: log every inbound activity so we can see exactly what Teams
    // sends (esp. on Graph proactive install). Safe to keep; cheap.
    console.log(
      `[teams] type=${activity.type} action=${activity.action ?? "-"}` +
      ` aad=${activity.from?.aadObjectId ?? "-"}` +
      ` membersAdded=${(activity.membersAdded ?? []).map((m) => m.id).join("|") || "-"}` +
      ` conv=${activity.conversation?.id ?? "-"}`
    );

    // Capture/refresh this user's conversation reference on normal messages so
    // BOB can message them first later (proactive). Keeps serviceUrl fresh.
    const proactiveId = activity.from?.aadObjectId;
    if (proactiveId && activity.type === "message") {
      await saveConvRef(proactiveId, TurnContext.getConversationReference(activity));
    }

    // First contact: BOB was installed/added for this user. Teams signals this
    // either as installationUpdate (action "add") when a user opens BOB, or as
    // conversationUpdate with the bot in membersAdded when installed via Graph
    // (proactive install). Handle both: store the ref + greet once (deduped).
    const botId = activity.recipient?.id;
    const isInstall = activity.type === "installationUpdate" && activity.action !== "remove";
    const botAdded =
      activity.type === "conversationUpdate" &&
      (activity.membersAdded ?? []).some((m) => m.id === botId);
    if (isInstall || botAdded) {
      const ref = TurnContext.getConversationReference(activity);
      await saveConvRef(activity.from?.aadObjectId ?? activity.conversation?.id ?? "unknown", ref);

      // Greet exactly once per user. A Graph install fires BOTH installationUpdate
      // and conversationUpdate — greeting on both (with different keys) double-messages.
      // So greet only on installationUpdate, deduped by the stable aadObjectId.
      if (isInstall && activity.from?.aadObjectId) {
        let firstTime = true;
        const r = getRedis();
        if (r) {
          try {
            firstTime = (await r.set(`bob:greeted:${activity.from.aadObjectId}`, 1, { nx: true, ex: 60 * 60 * 24 * 365 })) !== null;
          } catch (err) {
            console.error("greet dedupe: redis failed:", err); // fail-open → greet
          }
        }
        if (firstTime) await ctx.sendActivity(WELCOME_MESSAGE);
      }
      return;
    }
    // Ignore other lifecycle events (removes, member changes, etc.).
    if (activity.type === "installationUpdate" || activity.type === "conversationUpdate") return;

    // Handle feedback button clicks
    if (activity.type === "message" && (activity.value as { action?: string })?.action === "feedback") {
      const val = activity.value as { action: string; value: number; traceId: string };
      console.log(`Feedback: traceId=${val.traceId} score=${val.value}`);
      await scoreTrace(val.traceId, "user-feedback", val.value);
      await ctx.sendActivity("ขอบคุณสำหรับ feedback ครับ!");
      return;
    }

    if (activity.type !== "message") return;

    const message = (activity.text ?? "").trim();
    if (!message) return;

    // Admin command: pull latest KB from Outline into Redis
    if (/^\/refresh\b/i.test(message)) {
      await handleRefreshCommand(ctx);
      return;
    }

    // Self-service: anyone can reset their own conversation memory.
    if (isClearCommand(message)) {
      const convId = activity.conversation?.id ?? activity.from.aadObjectId ?? activity.from.id ?? "unknown";
      await clearHistory(convId);
      await ctx.sendActivity("ล้างความจำเรียบร้อยครับ เริ่มต้นบทสนทนาใหม่ได้เลย 🧹");
      return;
    }

    // Extract identity from Azure AD payload. Prefer email as the Langfuse user id.
    const aadId = activity.from.aadObjectId ?? activity.from.id ?? "unknown";

    // Rate limit per user before doing any expensive work.
    const rl = await checkRateLimit(aadId);
    if (!rl.allowed) {
      await ctx.sendActivity("ขออภัยครับ คุณส่งข้อความถี่เกินไป รบกวนรอสักครู่แล้วลองใหม่นะครับ 🙏");
      return;
    }

    // Real question — keep a typing indicator alive while we resolve identity
    // and run the (sometimes 10–20s) LLM pipeline.
    const stopTyping = startTyping(ctx);
    try {
      const userName = activity.from.name ?? "คุณ";
      const userId = (await resolveEmail(ctx, aadId)) || aadId;

      const convId = activity.conversation?.id ?? userId;
      const history = await getHistory(convId);

      const output = await runPipeline({ message, userId, userName, history, sessionId: convId, channel: "teams" });

      await appendHistory(convId, message, output.answer);

      const reply = buildAdaptiveCard(output);
      await ctx.sendActivity(reply);
    } finally {
      stopTyping();
    }
  });
}
