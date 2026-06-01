import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env } from "../env.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FALLBACK_DIR = join(root, "prompts", "fallback");

// Cache fetched prompts in memory (module-level, survives warm Vercel invocations)
const cache = new Map<string, string>();

function loadFallback(name: string): string {
  const cached = cache.get(`local:${name}`);
  if (cached) return cached;
  const text = readFileSync(join(FALLBACK_DIR, `${name}.txt`), "utf8");
  cache.set(`local:${name}`, text);
  return text;
}

async function fetchFromLangfuse(name: string): Promise<string | null> {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  const cached = cache.get(`lf:${name}`);
  if (cached) return cached;

  try {
    const auth = Buffer.from(
      `${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`
    ).toString("base64");
    const res = await fetch(
      `${env.LANGFUSE_HOST}/api/public/v2/prompts/${encodeURIComponent(name)}?label=production`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { prompt?: string | Array<{ text?: string }> };
    let text: string | null = null;
    if (typeof j.prompt === "string") text = j.prompt;
    else if (Array.isArray(j.prompt)) text = j.prompt.map((b) => b.text ?? "").join("");
    if (text) cache.set(`lf:${name}`, text);
    return text;
  } catch {
    return null;
  }
}

/**
 * Get a prompt by name. Tries Langfuse (label=production) first,
 * falls back to prompts/fallback/<name>.txt.
 */
export async function getPrompt(name: string): Promise<string> {
  const remote = await fetchFromLangfuse(name);
  if (remote) return remote;
  return loadFallback(name);
}

/** Clear the in-memory cache (useful in tests or after prompt updates) */
export function clearPromptCache(): void {
  cache.clear();
}
