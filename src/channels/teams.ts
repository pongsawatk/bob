// MS Teams channel adapter — wraps Bot Framework request/response.
// AZURE_BOT_ID / AZURE_BOT_SECRET must be set for authentication to work.

import { BotFrameworkAdapter, type TurnContext, type Activity } from "botbuilder";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runPipeline, type PipelineOutput } from "../pipeline/index.js";
import { env } from "../env.js";

// Singleton adapter (re-used across warm Vercel invocations)
let _adapter: BotFrameworkAdapter | null = null;

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
      // TODO Phase 3: call langfuse.score(val.traceId, val.value)
      await ctx.sendActivity("ขอบคุณสำหรับ feedback ครับ!");
      return;
    }

    if (activity.type !== "message") return;

    const message = (activity.text ?? "").trim();
    if (!message) return;

    // Extract identity from Azure AD payload
    const userId = activity.from.aadObjectId ?? activity.from.id ?? "unknown";
    const userName = activity.from.name ?? "คุณ";

    const output = await runPipeline({ message, userId, userName });
    const reply = buildAdaptiveCard(output);
    await ctx.sendActivity(reply);
  });
}
