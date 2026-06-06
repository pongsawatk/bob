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
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { Redis } from "@upstash/redis";
import botbuilder from "botbuilder";

const { BotFrameworkAdapter } = botbuilder;

loadEnv();

const { values: args } = parseArgs({
  options: {
    to:          { type: "string" },
    msg:         { type: "string" },
    team:        { type: "string" },  // Teams team/channel link or "19:...@thread.tacv2" id — used to read the member roster
    all:         { type: "boolean" }, // DM everyone with a stored conversation reference
    provision:   { type: "boolean" }, // Graph-install BOB for users → fires installationUpdate → bot greets
    check:       { type: "boolean" }, // read-only: is BOB currently installed for these users? (--emails)
    force:       { type: "boolean" }, // with --provision: uninstall first, then reinstall (re-fires greet for already-installed users)
    emails:      { type: "string" },  // comma-separated emails to target (with --provision)
    "emails-file": { type: "string" }, // path to a file/CSV; emails are auto-extracted
    "all-users": { type: "boolean" }, // target every enabled INTERNAL user in the org (with --provision)
    domain:      { type: "string" },  // restrict --all-users to this email domain (e.g., builk.com)
    exclude:     { type: "string" },  // comma-separated emails to skip
    limit:       { type: "string" },  // cap the number of users (staged rollout)
    "app-id":    { type: "string" },  // override the Teams catalog app id
    "dry-run":   { type: "boolean" }, // list recipients only, don't act
  },
});

// Need at least one target selector.
if (!args.team && !args.to && !args.all && !args.provision && !args.check) {
  console.error("❌ ระบุเป้าหมาย: --to <email> | --all | --team <link|threadId> | --provision | --check (--emails a,b | --all-users)");
  process.exit(1);
}

// Teams catalog app id for BOB (stable). Override with --app-id if it ever changes.
const APP_CATALOG_ID = args["app-id"] ?? "d3d89d68-4c1e-44d0-83a8-85e57e977a28";

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

// ── Mode 5: Graph-install BOB for users → fires installationUpdate → bot greets ─

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listAllUsers(token) {
  const users = [];
  let url =
    "https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,mail,accountEnabled,userType&$top=999";
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(`list users → ${res.status}: ${JSON.stringify(data)}`);
    users.push(...(data.value ?? []));
    url = data["@odata.nextLink"] ?? null;
  }
  return users;
}

// Read-only: report whether BOB is currently installed for each email.
async function checkInstall() {
  if (!args.emails) {
    console.error("❌ --check ต้องใช้คู่กับ --emails a,b,c");
    process.exit(1);
  }
  const token = await getGraphToken();
  const emails = args.emails.split(",").map((s) => s.trim()).filter(Boolean);
  let installedN = 0, notN = 0;
  for (const e of emails) {
    try {
      const u = await graph(token, "GET", `/users/${encodeURIComponent(e)}?$select=id,displayName`);
      const apps = await graph(token, "GET", `/users/${u.id}/teamwork/installedApps?$expand=teamsApp`);
      const has = (apps.value ?? []).some(
        (a) => a.teamsApp?.displayName?.toLowerCase().includes("bob") || a.teamsApp?.id === APP_CATALOG_ID
      );
      console.log(`  ${has ? "🟡 ยังติดตั้งอยู่ (entitled)" : "✅ หลุดแล้ว (un-entitled)"}  ${u.displayName} <${e}>`);
      has ? installedN++ : notN++;
    } catch (err) {
      console.log(`  ❌ ${e}: ${err.message.slice(0, 80)}`);
    }
  }
  console.log(`\nสรุป: ยังติดตั้ง ${installedN} คน · หลุดแล้ว ${notN} คน`);
  if (installedN === 0) console.log("→ พร้อม provision ได้เลย (ทุกคน un-entitled แล้ว)");
  else console.log("→ ยังมีคนที่ entitled อยู่ รอ propagate แล้วเช็คซ้ำ");
}

async function provisionUsers() {
  const token = await getGraphToken();

  // Resolve the target list.
  let targets = [];
  if (args["emails-file"]) {
    // Read a curated file/CSV; auto-extract each email (works regardless of name
    // formatting). Graph accepts the UPN/email as the user key, so no id lookup.
    const raw = readFileSync(args["emails-file"], "utf8");
    const seen = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
      if (!m) continue;
      const email = m[0];
      if (seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      const name = (line.split(",")[0] ?? email).replace(/^"|"$/g, "").trim();
      targets.push({ id: email, userPrincipalName: email, displayName: name || email });
    }
    console.log(`• อ่านจากไฟล์ ${args["emails-file"]} → ${targets.length} อีเมล`);
  } else if (args.emails) {
    const emails = args.emails.split(",").map((s) => s.trim()).filter(Boolean);
    process.stdout.write(`• Resolving ${emails.length} email(s)... `);
    for (const e of emails) {
      const u = await graph(token, "GET", `/users/${encodeURIComponent(e)}?$select=id,displayName,userPrincipalName`);
      targets.push(u);
    }
    console.log("✅");
  } else if (args["all-users"]) {
    process.stdout.write("• Listing all org users... ");
    const all = await listAllUsers(token);
    const domain = args.domain?.toLowerCase();
    const manualExclude = new Set(
      (args.exclude ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
    // Skip shared mailboxes / resigned / service accounts.
    const EXCLUDE_NAME = /\[resign|\(shared\)|shared mailbox|do not use|ห้ามใช้|test account/i;
    const EXCLUDE_LOCAL = new Set([
      "acc", "accba", "account", "admin", "adobe01", "adobe02",
      "info", "support", "noreply", "no-reply", "test", "notification", "notifications",
    ]);
    targets = all.filter((u) => {
      if (u.accountEnabled === false) return false;
      if (u.userType === "Guest") return false;            // skip external guests
      const upn = (u.userPrincipalName ?? "").toLowerCase();
      if (upn.includes("#ext#")) return false;             // skip external/B2B
      const email = (u.mail ?? upn).toLowerCase();
      if (domain && !email.endsWith("@" + domain)) return false;
      if (manualExclude.has(email)) return false;
      if (EXCLUDE_NAME.test(u.displayName ?? "")) return false;
      if (EXCLUDE_LOCAL.has(email.split("@")[0])) return false;
      return true;
    });
    console.log(`✅  (${all.length} total → ${targets.length} หลังกรอง${domain ? " @" + domain : ""})`);
  } else {
    console.error("❌ --provision ต้องระบุ --emails a,b,c หรือ --all-users");
    process.exit(1);
  }

  if (args.limit) targets = targets.slice(0, parseInt(args.limit, 10));

  console.log(`\nจะติดตั้ง BOB (Graph) ให้ ${targets.length} คน → bot จะทักทายอัตโนมัติเมื่อ install สำเร็จ`);
  for (const u of targets.slice(0, 10)) {
    console.log(`  • ${u.displayName ?? "?"}  <${u.userPrincipalName ?? "?"}>`);
  }
  if (targets.length > 10) console.log(`  … และอีก ${targets.length - 10} คน`);

  if (args["dry-run"]) {
    // Write the full target list to a CSV for review before the real run.
    mkdirSync("test-results", { recursive: true });
    const outPath = `test-results/provision-targets-${new Date().toISOString().slice(0, 10)}.csv`;
    const rows = ["name,email", ...targets.map((u) => `"${(u.displayName ?? "").replace(/"/g, "'")}",${u.userPrincipalName ?? ""}`)];
    writeFileSync(outPath, rows.join("\n"), "utf8");
    console.log(`\n(dry-run) ไม่ติดตั้งจริง — เขียนรายชื่อทั้ง ${targets.length} คนไว้ที่:\n  ${outPath}`);
    return;
  }

  console.log("");
  let installed = 0, already = 0, fail = 0;
  for (const u of targets) {
    const who = u.displayName ?? u.userPrincipalName ?? u.id;
    process.stdout.write(`  → install for ${who}... `);
    try {
      // --force: uninstall an existing BOB install first so the POST below is a
      // fresh install that re-fires installationUpdate (re-greets the user).
      if (args.force) {
        try {
          const apps = await graph(token, "GET", `/users/${u.id}/teamwork/installedApps?$expand=teamsApp`);
          const inst = (apps.value ?? []).find(
            (a) => a.teamsApp?.displayName?.toLowerCase().includes("bob") || a.teamsApp?.id === APP_CATALOG_ID
          );
          if (inst) {
            await graph(token, "DELETE", `/users/${u.id}/teamwork/installedApps/${inst.id}`);
            process.stdout.write("(uninstalled) ");
            await sleep(800);
          }
        } catch (e) {
          process.stdout.write(`(uninstall skip: ${e.message.slice(0, 40)}) `);
        }
      }
      let res, attempt = 0;
      while (true) {
        res = await fetch(
          `https://graph.microsoft.com/v1.0/users/${u.id}/teamwork/installedApps`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${APP_CATALOG_ID}`,
            }),
          }
        );
        if (res.status === 429 && attempt < 5) {        // throttled → back off + retry
          const ra = parseInt(res.headers.get("retry-after") || "10", 10);
          process.stdout.write(`(429, รอ ${ra}s) `);
          await sleep((ra || 10) * 1000);
          attempt++;
          continue;
        }
        break;
      }
      if (res.status === 201) { console.log("✅ installed → จะทักทาย"); installed++; }
      else if (res.status === 409) { console.log("• มีอยู่แล้ว (ต้องเปิดเอง 1 ครั้ง)"); already++; }
      else {
        const d = await res.json().catch(() => ({}));
        console.log(`❌ ${res.status} ${JSON.stringify(d).slice(0, 100)}`);
        fail++;
      }
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 100)}`);
      fail++;
    }
    await sleep(200); // be gentle on Graph throttling
  }
  console.log(
    `\n✅ ติดตั้งใหม่ ${installed} คน (จะได้ข้อความทักทาย)` +
    ` · มีอยู่แล้ว ${already} คน` +
    (fail ? ` · ❌ ล้มเหลว ${fail} คน` : "")
  );
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
  // Read-only check: is BOB still installed for these users? (un-entitle progress)
  if (args.check) {
    console.log(`\n🔎 Check install state\n`);
    await checkInstall();
    return;
  }

  // Provision mode: Graph-install BOB for users → fires installationUpdate → bot greets.
  if (args.provision) {
    console.log(`\n🚀 Provision (Graph install) → bot greets on install  (${args["dry-run"] ? "dry-run" : "run"})\n`);
    await provisionUsers();
    return;
  }

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
