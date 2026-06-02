// MS Teams channel adapter — wraps Bot Framework request/response.
// AZURE_BOT_ID / AZURE_BOT_SECRET must be set for authentication to work.

import { BotFrameworkAdapter, TeamsInfo, type TurnContext, type Activity } from "botbuilder";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runPipeline, type PipelineOutput, type LLMMessage } from "../pipeline/index.js";
import { refreshKB } from "../kb/index.js";
import { scoreTrace } from "../obs/langfuse.js";
import { env } from "../env.js";

// Singleton adapter (re-used across warm Vercel invocations)
let _adapter: BotFrameworkAdapter | null = null;

// In-memory conversation history — persists across warm invocations, resets on cold start.
// Key = Teams conversation ID, Value = last N message pairs.
const MAX_HISTORY_MESSAGES = 14; // 7 turns
const conversationHistory = new Map<string, LLMMessage[]>();

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

    // Extract identity from Azure AD payload. Prefer email as the Langfuse user id.
    const aadId = activity.from.aadObjectId ?? activity.from.id ?? "unknown";
    const userName = activity.from.name ?? "คุณ";
    const userId = (await resolveEmail(ctx, aadId)) || aadId;

    const convId = activity.conversation?.id ?? userId;
    const history = conversationHistory.get(convId) ?? [];

    const output = await runPipeline({ message, userId, userName, history });

    // Update history — keep last MAX_HISTORY_MESSAGES messages
    const updated = [
      ...history,
      { role: "user" as const, content: message },
      { role: "assistant" as const, content: output.answer },
    ].slice(-MAX_HISTORY_MESSAGES);
    conversationHistory.set(convId, updated);

    const reply = buildAdaptiveCard(output);
    await ctx.sendActivity(reply);
  });
}
