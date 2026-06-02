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

// Local fallback files never change at runtime — cache them permanently.
const localCache = new Map<string, LoadedPrompt>();

// Langfuse prompts can be edited by non-devs at any time. Cache them only
// briefly so an edit (new production version) propagates to every warm
// instance within ~60s without a redeploy.
const LF_TTL_MS = 60_000;
const lfCache = new Map<string, { prompt: LoadedPrompt; at: number }>();

function loadFallback(name: string): LoadedPrompt {
  const cached = localCache.get(name);
  if (cached) return cached;
  const text = readFileSync(join(FALLBACK_DIR, `${name}.txt`), "utf8");
  const prompt: LoadedPrompt = { text, version: "fallback" };
  localCache.set(name, prompt);
  return prompt;
}

async function fetchFromLangfuse(name: string): Promise<LoadedPrompt | null> {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  const cached = lfCache.get(name);
  if (cached && Date.now() - cached.at < LF_TTL_MS) return cached.prompt;

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
    lfCache.set(name, { prompt, at: Date.now() });
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
  localCache.clear();
  lfCache.clear();
}
