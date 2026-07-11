// G1 SPIKE — Teams report delivery (DRAFT; run by an admin against THEMSELVES).
// Proves what the bot can actually deliver in the production 1:1 channel, so WP-12
// can pick a real delivery path for the /insight report. Sends four methods to one
// target and reports which the SDK accepted; you then eyeball your Teams chat to see
// what truly rendered (SDK acceptance ≠ visible render).
//
//   npx tsx scripts/spike-teams-delivery.mjs --to <YOUR_AAD_OBJECT_ID>
//
// Find your AAD object id: it's the key of your bob:convref:* entry in Redis, or
// ask BOB anything and read it from the function logs. Only messages the id you pass.
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { BotFrameworkAdapter } = await import("botbuilder");
const { loadConvRef } = await import("../src/channels/convref.ts");
const { env } = await import("../src/env.ts");

const to = (() => {
  const i = process.argv.indexOf("--to");
  return i >= 0 ? process.argv[i + 1] : process.env.SPIKE_TARGET_AAD;
})();
if (!to) {
  console.error("usage: spike-teams-delivery.mjs --to <AAD_OBJECT_ID>");
  process.exit(1);
}

const ref = await loadConvRef(to);
if (!ref) {
  console.error(`no conversation reference for ${to} — DM BOB once first, then retry.`);
  process.exit(1);
}

const adapter = new BotFrameworkAdapter({
  appId: env.AZURE_BOT_ID || undefined,
  appPassword: env.AZURE_BOT_SECRET || undefined,
  channelAuthTenant: env.AZURE_TENANT_ID || undefined,
});

// A short fake "report" link for the OpenUrl / file tests (replace with a real
// secure-expiring link when wiring WP-12).
const SAMPLE_LINK = "https://outline.builk.id/";

const methods = [
  {
    name: "1) Adaptive Card (baseline)",
    activity: {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
          body: [{ type: "TextBlock", wrap: true, text: "🧪 spike 1/4 — baseline card OK" }] },
      }],
    },
  },
  {
    name: "2) Card + Action.OpenUrl (secure-link delivery)",
    activity: {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
          body: [{ type: "TextBlock", wrap: true, text: "🧪 spike 2/4 — report link" }],
          actions: [{ type: "Action.OpenUrl", title: "เปิดรายงาน", url: SAMPLE_LINK }] },
      }],
    },
  },
  {
    name: "3) FileConsentCard (bot-native file upload in 1:1)",
    activity: {
      type: "message",
      attachments: [{
        contentType: "application/vnd.microsoft.teams.card.file.consent",
        name: "bob-insight-7d.md",
        content: { description: "🧪 spike 3/4 — accept to receive a file", sizeInBytes: 1024, acceptContext: { spike: true }, declineContext: { spike: true } },
      }],
    },
  },
  {
    name: "4) Chunked plain text (fallback for long reports)",
    activity: { type: "message", text: "🧪 spike 4/4 — chunk 1/2 …" },
    followup: { type: "message", text: "🧪 spike 4/4 — chunk 2/2 (end)" },
  },
];

console.log(`\n=== Teams delivery spike → ${to} ===`);
for (const m of methods) {
  try {
    await adapter.continueConversation(ref, async (ctx) => {
      await ctx.sendActivity(m.activity);
      if (m.followup) await ctx.sendActivity(m.followup);
    });
    console.log(`  ${m.name}: SDK accepted ✓`);
  } catch (err) {
    console.log(`  ${m.name}: FAILED ✗ — ${String(err).slice(0, 160)}`);
  }
}
console.log(`\n→ Now open your Teams chat with BOB. Record for each method: did it RENDER,`);
console.log(`  and for the file consent — did tapping "Accept" work? That decides WP-12 delivery.`);
