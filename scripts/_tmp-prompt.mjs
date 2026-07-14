// Ad-hoc Langfuse prompt tool for the WP prompt workflow: get / diff / create-candidate / promote.
import { loadEnv } from "./_load-env.mjs";
import { readFileSync } from "node:fs";
loadEnv();
const host = process.env.LANGFUSE_HOST || "https://cloud.langfuse.com";
const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
const H = { Authorization: `Basic ${auth}`, "Content-Type": "application/json" };

const [cmd, name, arg] = process.argv.slice(2);

async function get(name, label = "production") {
  const res = await fetch(`${host}/api/public/v2/prompts/${encodeURIComponent(name)}?label=${label}`, { headers: H });
  if (!res.ok) throw new Error(`GET ${name}@${label} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

if (cmd === "get") {
  const j = await get(name, arg || "production");
  console.error(`--- ${name} v${j.version} labels=${JSON.stringify(j.labels)} ---`);
  console.log(typeof j.prompt === "string" ? j.prompt : JSON.stringify(j.prompt));
} else if (cmd === "version") {
  const res = await fetch(`${host}/api/public/v2/prompts/${encodeURIComponent(name)}?version=${arg}`, { headers: H });
  const j = await res.json();
  console.log(typeof j.prompt === "string" ? j.prompt : JSON.stringify(j.prompt));
} else if (cmd === "create-candidate") {
  // arg = path to the new prompt text. Publishes a NEW version labelled `candidate`
  // only — the loader reads ?label=production, so production is untouched.
  const text = readFileSync(arg, "utf8");
  const res = await fetch(`${host}/api/public/v2/prompts`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name, type: "text", prompt: text, labels: ["candidate"], commitMessage: process.env.MSG || "candidate" }),
  });
  const body = await res.text();
  console.log(res.ok ? `✅ ${name} candidate → v${JSON.parse(body).version}` : `❌ HTTP ${res.status}: ${body.slice(0, 400)}`);
} else if (cmd === "promote") {
  // arg = version number to move the `production` label onto.
  const res = await fetch(`${host}/api/public/v2/prompts/${encodeURIComponent(name)}/versions/${arg}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ newLabels: ["production"] }),
  });
  const body = await res.text();
  console.log(res.ok ? `✅ ${name} v${arg} → production` : `❌ HTTP ${res.status}: ${body.slice(0, 400)}`);
} else {
  console.log("usage: _tmp-prompt.mjs get|version|create-candidate|promote <name> [arg]");
}
