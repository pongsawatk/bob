// WP-12 slice 6 — deliver the finished report to the requester in Teams.
// Order (spike #3): summary Adaptive Card + Action.OpenUrl to a secure link → if that
// throws, chunked plain-text fallback. File upload is intentionally skipped (spike #3:
// FileConsentCard needs a live invoke handler — post-MVP).

import { BotFrameworkAdapter, type Activity, type ConversationReference, type TurnContext } from "botbuilder";
import { env } from "../env.js";
import { loadConvRef } from "./convref.js";
import { reportUrl } from "../analytics/reportLink.js";
import type { JobRecord } from "../analytics/job.js";

export type DeliveryOutcome = "link" | "chunked" | "failed";

let _adapter: BotFrameworkAdapter | null = null;
function adapter(): BotFrameworkAdapter {
  return (_adapter ??= new BotFrameworkAdapter({
    appId: env.AZURE_BOT_ID || undefined,
    appPassword: env.AZURE_BOT_SECRET || undefined,
    channelAuthTenant: env.AZURE_TENANT_ID || undefined,
  }));
}

function summaryCard(days: number, url: string): Partial<Activity> {
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
            { type: "TextBlock", weight: "Bolder", size: "Medium", wrap: true, text: `📊 รายงาน BOB Insight ${days} วัน พร้อมแล้ว` },
            { type: "TextBlock", isSubtle: true, wrap: true, text: "กดปุ่มด้านล่างเพื่อเปิดรายงานฉบับเต็ม (ลิงก์จะหมดอายุใน 24 ชม.)" },
          ],
          actions: [{ type: "Action.OpenUrl", title: "เปิดรายงาน", url }],
        },
      },
    ],
  };
}

/** Split a long report into Teams-safe chunks on line boundaries. */
export function chunkText(text: string, size = 3500): string[] {
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf.length + line.length + 1 > size && buf) {
      out.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) out.push(buf);
  return out;
}

export async function deliverReport(job: JobRecord, report: string): Promise<DeliveryOutcome> {
  const ref = await loadConvRef(job.requestedBy);
  if (!ref) return "failed";
  const url = reportUrl(job.jobId);

  const sendChunked = async (ctx: TurnContext): Promise<void> => {
    for (const c of chunkText(report)) await ctx.sendActivity(c);
  };

  try {
    await adapter().continueConversation(ref as ConversationReference, async (ctx) => {
      if (url) await ctx.sendActivity(summaryCard(job.windowDays, url));
      else await sendChunked(ctx);
    });
    return url ? "link" : "chunked";
  } catch (err) {
    console.error("deliverReport: primary send failed, trying chunked:", err);
    try {
      await adapter().continueConversation(ref as ConversationReference, sendChunked);
      return "chunked";
    } catch (err2) {
      console.error("deliverReport: chunked fallback failed:", err2);
      return "failed";
    }
  }
}
