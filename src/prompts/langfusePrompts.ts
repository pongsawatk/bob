import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env.js";

// process.cwd() = project root both locally and on Vercel (/var/task)
const FALLBACK_DIR = join(process.cwd(), "prompts", "fallback");

export interface LoadedPrompt {
  text: string;
  /** Prompt version for Langfuse's Version column: "v3" (Langfuse) or "fallback" (local file). */
  version: string;
}

// Cache fetched prompts in memory (module-level, survives warm Vercel invocations)
const cache = new Map<string, LoadedPrompt>();

function loadFallback(name: string): LoadedPrompt {
  const cached = cache.get(`local:${name}`);
  if (cached) return cached;
  const text = readFileSync(join(FALLBACK_DIR, `${name}.txt`), "utf8");
  const prompt: LoadedPrompt = { text, version: "fallback" };
  cache.set(`local:${name}`, prompt);
  return prompt;
}

async function fetchFromLangfuse(name: string): Promise<LoadedPrompt | null> {
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
    const j = (await res.json()) as { prompt?: string | Array<{ text?: string }>; version?: number };
    let text: string | null = null;
    if (typeof j.prompt === "string") text = j.prompt;
    else if (Array.isArray(j.prompt)) text = j.prompt.map((b) => b.text ?? "").join("");
    if (!text) return null;
    const prompt: LoadedPrompt = { text, version: j.version != null ? `v${j.version}` : "production" };
    cache.set(`lf:${name}`, prompt);
    return prompt;
  } catch {
    return null;
  }
}

/**
 * Get a prompt by name. Tries Langfuse (label=production) first,
 * falls back to prompts/fallback/<name>.txt.
 */
export async function getPrompt(name: string): Promise<LoadedPrompt> {
  const remote = await fetchFromLangfuse(name);
  if (remote) return remote;
  return loadFallback(name);
}

/** Clear the in-memory cache (useful in tests or after prompt updates) */
export function clearPromptCache(): void {
  cache.clear();
}
