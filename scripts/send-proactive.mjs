#!/usr/bin/env node
/**
 * send-proactive.mjs — ทำให้ BOB ทักหา user ก่อน (proactive) ใน Teams
 *
 * โหมดการทำงาน:
 *   1) Trigger welcome (default) — re-install แอปให้ user ผ่าน Graph เพื่อจุดชนวน
 *      `installationUpdate` → บอท (ที่ deploy แล้ว) จะส่งข้อความต้อนรับเอง + เก็บ
 *      conversation reference ลง Redis
 *        node scripts/send-proactive.mjs --to pawanpat@builk.com
 *
 *   2) Custom message — โหลด conversation reference จาก Redis แล้วส่งข้อความเอง
 *      ผ่าน Bot Framework (ใช้ได้หลัง user เคย install-after-deploy หรือเคยทักบอท)
 *        node scripts/send-proactive.mjs --to pawanpat@builk.com --msg "ข้อความ"
 *
 * Prerequisites:
 *   - Deploy โค้ดที่มี installationUpdate handler ก่อน (git push → Vercel)
 *   - .env: AZURE_BOT_ID, AZURE_BOT_SECRET, AZURE_TENANT_ID,
 *           UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   - App Reg permission (Application, granted): User.Read.All,
 *           TeamsAppInstallation.ReadWriteForUser.All
 */

import { loadEnv } from "./_load-env.mjs";
import { parseArgs } from "node:util";
import { Redis } from "@upstash/redis";
import botbuilder from "botbuilder";

const { BotFrameworkAdapter } = botbuilder;

loadEnv();

const { values: args } = parseArgs({
  options: {
    to:  { type: "string" },
    msg: { type: "string" },
  },
});

if (!args.to) {
  console.error("❌ Missing --to <email>");
  process.exit(1);
}

const CLIENT_ID     = process.env.AZURE_BOT_ID;
const CLIENT_SECRET = process.env.AZURE_BOT_SECRET;
const TENANT_ID     = process.env.AZURE_TENANT_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID) {
  console.error("❌ Missing AZURE_BOT_ID / AZURE_BOT_SECRET / AZURE_TENANT_ID in .env");
  process.exit(1);
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

async function getGraphToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         "https://graph.microsoft.com/.default",
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function graph(token, method, path, body) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ── Mode 2: send a custom message via stored conversation reference ───────────

async function sendCustomMessage(userId) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) {
    console.error("❌ Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env");
    process.exit(1);
  }
  const redis = new Redis({ url, token: tok });

  process.stdout.write("• Loading conversation reference from Redis... ");
  const ref = await redis.get(`bob:convref:${userId}`);
  if (!ref) {
    console.log("❌");
    console.error(
      "\nไม่มี conversation reference ของ user คนนี้ใน Redis\n" +
      "→ รันโหมด trigger ก่อน (ไม่ต้องใส่ --msg) เพื่อให้บอทเก็บ ref:\n" +
      `   node scripts/send-proactive.mjs --to ${args.to}`
    );
    process.exit(1);
  }
  console.log("✅");

  const adapter = new BotFrameworkAdapter({
    appId: CLIENT_ID,
    appPassword: CLIENT_SECRET,
    channelAuthTenant: TENANT_ID, // single-tenant bot
  });

  process.stdout.write("• Sending message via Bot Framework... ");
  await adapter.continueConversation(ref, async (ctx) => {
    await ctx.sendActivity(args.msg);
  });
  console.log("✅\n");
  console.log(`✅ BOB ส่งข้อความถึง ${args.to} แล้วครับ`);
  console.log(`   "${args.msg}"`);
}

// ── Mode 1: re-install to trigger the bot's welcome message ───────────────────

async function triggerWelcome(token, userId) {
  process.stdout.write("3. Finding BOB app installation... ");
  const apps = await graph(token, "GET", `/users/${userId}/teamwork/installedApps?$expand=teamsApp`);
  const inst = apps.value?.find(
    (a) =>
      a.teamsApp?.displayName?.toLowerCase().includes("bob") ||
      a.teamsApp?.externalId === CLIENT_ID
  );
  if (!inst) {
    console.log("\n❌ BOB ไม่อยู่ในรายการแอปที่ติดตั้งให้ user คนนี้");
    process.exit(1);
  }
  const installId  = inst.id;
  const teamsAppId = inst.teamsApp?.id;
  console.log(`✅  (teamsAppId: ${teamsAppId})`);

  process.stdout.write("4. Uninstalling (to reset install state)... ");
  await graph(token, "DELETE", `/users/${userId}/teamwork/installedApps/${installId}`);
  console.log("✅");

  process.stdout.write("5. Re-installing → triggers BOB welcome... ");
  await graph(token, "POST", `/users/${userId}/teamwork/installedApps`, {
    "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teamsAppId}`,
  });
  console.log("✅\n");

  console.log(`✅ Done! BOB จะส่งข้อความต้อนรับไปหา ${args.to} ใน Teams`);
  console.log(`   (ข้อความมาจาก installationUpdate handler ในโค้ดที่ deploy แล้ว)`);
  console.log(`   ถ้าไม่เห็นข้อความ → เช็คว่า deploy เวอร์ชันล่าสุดแล้วหรือยัง`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📨 Proactive → ${args.to}  (${args.msg ? "custom message" : "trigger welcome"})\n`);

  process.stdout.write("1. Getting Graph API token... ");
  const token = await getGraphToken();
  console.log("✅");

  process.stdout.write(`2. Looking up user ${args.to}... `);
  const user = await graph(token, "GET", `/users/${encodeURIComponent(args.to)}`);
  const userId = user.id;
  console.log(`✅  (id: ${userId})`);

  if (args.msg) {
    await sendCustomMessage(userId);
  } else {
    await triggerWelcome(token, userId);
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
