// G1 SPIKE — Azure AD authorization (read-only). Proves whether the bot's app
// registration can resolve a user's GROUP membership via Graph, so /insight admin
// gating can use an AD security group (Metric Contract requirement #2) instead of
// the current email allowlist. If Graph 403s, the app is missing a permission
// (GroupMember.Read.All or Directory.Read.All → needs admin consent) and we stay on
// the email fallback until that's granted.
//
//   npx tsx scripts/spike-aad-auth.mjs --email you@builk.com [--group <GROUP_OBJECT_ID>]
//
// Reads directory data only (group ids/names). No writes. Reuses the bot's
// client-credentials token (same app that already reads the HR sheet).
import { loadEnv } from "./_load-env.mjs";
loadEnv();

const { graphToken } = await import("../src/people/directory.ts");

const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };
const email = arg("--email");
const wantGroup = arg("--group");
if (!email) {
  console.error("usage: spike-aad-auth.mjs --email <user@builk.com> [--group <GROUP_OBJECT_ID>]");
  process.exit(1);
}

const token = await graphToken();
const g = async (path) => {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
};

console.log(`\n=== Azure AD auth spike — ${email} ===`);

// 1) Resolve the user (also proves User.Read.All-ish access already used elsewhere).
const u = await g(`/users/${encodeURIComponent(email)}?$select=id,displayName,userPrincipalName`);
if (!u.ok) {
  console.log(`resolve user: ✗ HTTP ${u.status} — ${JSON.stringify(u.body?.error?.message ?? u.body).slice(0, 160)}`);
  process.exit(0);
}
const userId = u.body.id;
console.log(`resolve user: ✓ objectId=${userId}`);

// 2) The real question: can we read this user's group memberships?
const groups = await g(`/users/${userId}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName&$top=50`);
if (!groups.ok) {
  console.log(`read group membership: ✗ HTTP ${groups.status} — ${JSON.stringify(groups.body?.error?.message ?? groups.body).slice(0, 200)}`);
  console.log(`\nverdict: app CANNOT resolve groups → grant GroupMember.Read.All (or Directory.Read.All)`);
  console.log(`+ admin consent, OR keep the email allowlist as the admin gate for /insight.`);
  process.exit(0);
}
const list = groups.body.value ?? [];
console.log(`read group membership: ✓ ${list.length} groups`);
for (const grp of list.slice(0, 50)) console.log(`   - ${grp.id}  ${grp.displayName}`);

if (wantGroup) {
  const inGroup = list.some((x) => x.id === wantGroup);
  console.log(`\nis member of ${wantGroup}? ${inGroup ? "✓ YES → usable as the /insight admin group" : "✗ no"}`);
}
console.log(`\nverdict: app CAN read groups → /insight can gate on an AD security group id.`);
