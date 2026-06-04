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
    to:        { type: "string" },
    msg:       { type: "string" },
    team:      { type: "string" },  // Teams team/channel link or "19:...@thread.tacv2" id — used to read the member roster
    all:       { type: "boolean" }, // DM everyone with a stored conversation reference
    "dry-run": { type: "boolean" }, // list recipients only, don't send
  },
});

// Need at least one target selector.
if (!args.team && !args.to && !args.all) {
  console.error("❌ ระบุเป้าหมาย: --to <email> | --all (ทุก ref ที่เก็บไว้) | --team <link|threadId>");
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

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) {
    console.error("❌ Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env");
    process.exit(1);
  }
  return new Redis({ url, token: tok });
}

function makeAdapter() {
  return new BotFrameworkAdapter({
    appId: CLIENT_ID,
    appPassword: CLIENT_SECRET,
    channelAuthTenant: TENANT_ID, // single-tenant bot
  });
}

// ── Bot Framework connector (raw REST) ────────────────────────────────────────

async function getBotToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope:         "https://api.botframework.com/.default",
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`BF token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function bf(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function parseThreadId(input) {
  // Accept a raw "19:...@thread.tacv2" id or a full Teams team/channel link.
  const decoded = decodeURIComponent(input);
  const m = decoded.match(/19:[^/?\s]+@thread\.(?:tacv2|skype)/);
  return m ? m[0] : input;
}

// ── Mode 3: DM every member of a team 1:1 (uses the roster for real 29: ids) ──

async function broadcastToTeam() {
  if (!args.msg && !args["dry-run"]) {
    console.error("❌ --team ต้องใช้คู่กับ --msg \"ข้อความ\"  (หรือ --dry-run เพื่อดูรายชื่อก่อน)");
    process.exit(1);
  }

  // --team accepts a group/team object id (GUID), a Teams link, or a raw thread id.
  let threadId;
  const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.team.trim());
  if (isGuid) {
    process.stdout.write("• Resolving primary channel via Graph... ");
    const gToken = await getGraphToken();
    const ch = await graph(gToken, "GET", `/teams/${args.team.trim()}/primaryChannel`);
    threadId = ch.id;
    console.log("✅");
  } else {
    threadId = parseThreadId(args.team);
  }
  console.log(`• Team thread: ${threadId}`);

  // Reuse the serviceUrl from any stored conversation reference (same tenant/region).
  const redis = getRedisClient();
  process.stdout.write("• Finding a serviceUrl from stored refs... ");
  const keys = await redis.keys("bob:convref:*");
  let serviceUrl;
  for (const k of keys) {
    const ref = await redis.get(k);
    if (ref?.serviceUrl) { serviceUrl = ref.serviceUrl; break; }
  }
  if (!serviceUrl) {
    console.log("❌");
    console.error(
      "\nยังไม่มี serviceUrl ใน Redis — ต้องมี user เคย interact กับบอทอย่างน้อย 1 คนก่อน\n" +
      "(Pawanpat มี ref แล้ว ถ้า Redis ว่างให้เขาทักบอท 1 ครั้ง)"
    );
    process.exit(1);
  }
  if (!serviceUrl.endsWith("/")) serviceUrl += "/";
  console.log(`✅  (${serviceUrl})`);

  const token = await getBotToken();

  // Read the team roster → each member carries the real Teams id (29:...).
  process.stdout.write("• Reading team roster... ");
  const members = await bf(
    token,
    "GET",
    `${serviceUrl}v3/conversations/${encodeURIComponent(threadId)}/members`
  );
  const list = Array.isArray(members) ? members : (members.value ?? []);
  console.log(`✅  (${list.length} members)`);

  console.log("\nสมาชิกที่จะได้รับ 1:1 DM:");
  for (const m of list) {
    console.log(`  • ${m.name ?? m.givenName ?? "?"}  <${m.email ?? m.userPrincipalName ?? "no-email"}>`);
  }

  if (args["dry-run"]) {
    console.log("\n(dry-run) ไม่ส่งข้อความ — เอา --dry-run ออกเพื่อส่งจริง");
    return;
  }

  console.log("");
  let ok = 0, fail = 0;
  for (const m of list) {
    const who = m.name ?? m.email ?? m.id;
    process.stdout.write(`  → DM ${who}... `);
    try {
      const conv = await bf(token, "POST", `${serviceUrl}v3/conversations`, {
        bot: { id: `28:${CLIENT_ID}` },
        members: [{ id: m.id }],
        channelData: { tenant: { id: TENANT_ID } },
        isGroup: false,
      });
      await bf(token, "POST", `${serviceUrl}v3/conversations/${encodeURIComponent(conv.id)}/activities`, {
        type: "message",
        from: { id: `28:${CLIENT_ID}` },
        recipient: { id: m.id },
        text: args.msg,
      });
      console.log("✅");
      ok++;
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 120)}`);
      fail++;
    }
  }
  console.log(`\n✅ ส่งสำเร็จ ${ok} คน${fail ? ` · ❌ ล้มเหลว ${fail} คน` : ""}`);
}

// ── Mode 4: DM everyone with a stored conversation reference ──────────────────

async function broadcastToAll() {
  if (!args.msg && !args["dry-run"]) {
    console.error("❌ --all ต้องใช้คู่กับ --msg \"ข้อความ\"  (หรือ --dry-run เพื่อดูรายชื่อก่อน)");
    process.exit(1);
  }
  const redis = getRedisClient();
  process.stdout.write("• Loading stored conversation references... ");
  const keys = await redis.keys("bob:convref:*");
  const refs = [];
  for (const k of keys) {
    const ref = await redis.get(k);
    if (ref) refs.push(ref);
  }
  console.log(`✅  (${refs.length})`);

  console.log("\nผู้ที่จะได้รับ 1:1 DM:");
  for (const r of refs) console.log(`  • ${r.user?.name ?? "?"}`);

  if (args["dry-run"]) {
    console.log("\n(dry-run) ไม่ส่งข้อความ — เอา --dry-run ออกเพื่อส่งจริง");
    return;
  }

  const adapter = makeAdapter();
  console.log("");
  let ok = 0, fail = 0;
  for (const ref of refs) {
    const who = ref.user?.name ?? ref.conversation?.id ?? "?";
    process.stdout.write(`  → DM ${who}... `);
    try {
      await adapter.continueConversation(ref, async (ctx) => {
        await ctx.sendActivity(args.msg);
      });
      console.log("✅");
      ok++;
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 120)}`);
      fail++;
    }
  }
  console.log(`\n✅ ส่งสำเร็จ ${ok} คน${fail ? ` · ❌ ล้มเหลว ${fail} คน` : ""}`);
}

// ── Mode 2: send a custom message via stored conversation reference ───────────

async function sendCustomMessage(userId) {
  const redis = getRedisClient();

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

  const adapter = makeAdapter();

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
  try {
    await graph(token, "DELETE", `/users/${userId}/teamwork/installedApps/${installId}`);
  } catch (err) {
    if (err.message.includes("explicitly preinstalled") || err.message.includes("403")) {
      console.log("⚠️  ข้ามไม่ได้");
      console.error(
        "\n⚠️  แอปนี้ถูก admin install ให้ user แบบ explicit → uninstall ผ่าน Graph ไม่ได้\n\n" +
        "วิธีจุดชนวนข้อความต้อนรับ (เลือกอย่างใดอย่างหนึ่ง):\n\n" +
        "  ทาง A (BOB ทักก่อน): ใน Teams admin center → Manage apps → BOB Sidekick →\n" +
        "         Users and groups → เอา Pawanpat ออก → Save → เพิ่มกลับ → Save\n" +
        "         (re-provision จะยิง installationUpdate → BOB ทักทายเอง)\n\n" +
        "  ทาง B (เร็วสุด): ให้ Pawanpat เปิด BOB แล้วทัก 1 ครั้ง → บอทตอบ + เก็บ ref\n" +
        "         จากนั้นส่งข้อความ proactive ได้ด้วย:\n" +
        `         node scripts/send-proactive.mjs --to ${args.to} --msg \"...\"`
      );
      process.exit(1);
    }
    throw err;
  }
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
  // Broadcast to everyone with a stored conversation reference.
  if (args.all) {
    console.log(`\n📨 Proactive → all stored refs 1:1  (${args["dry-run"] ? "dry-run" : "send"})\n`);
    await broadcastToAll();
    return;
  }

  // Team mode needs no Graph user lookup — read the roster and DM each member.
  if (args.team) {
    console.log(`\n📨 Proactive → team members 1:1  (${args["dry-run"] ? "dry-run" : "send"})\n`);
    await broadcastToTeam();
    return;
  }

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
