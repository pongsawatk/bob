// Conversation history keyed by Teams conversation id.
// Stored in Redis so it survives Vercel cold starts (an in-memory Map would
// reset between invocations and the bot would forget the previous turn).

import { getRedis } from "../store/redis.js";
import type { LLMMessage } from "../llm/openrouter.js";

const MAX_HISTORY_MESSAGES = 14; // 7 turns
const TTL_SECONDS = 60 * 60; // conversation window: 1 hour of inactivity

// Fallback for local dev / when Redis isn't configured.
const memFallback = new Map<string, LLMMessage[]>();

function key(convId: string): string {
  return `bob:conv:${convId}`;
}

export async function getHistory(convId: string): Promise<LLMMessage[]> {
  const r = getRedis();
  if (!r) return memFallback.get(convId) ?? [];
  try {
    return (await r.get<LLMMessage[]>(key(convId))) ?? [];
  } catch (err) {
    console.error("getHistory: redis read failed:", err);
    return memFallback.get(convId) ?? [];
  }
}

export async function appendHistory(
  convId: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const prev = await getHistory(convId);
  const updated = [
    ...prev,
    { role: "user" as const, content: userMessage },
    { role: "assistant" as const, content: assistantMessage },
  ].slice(-MAX_HISTORY_MESSAGES);

  const r = getRedis();
  if (!r) {
    memFallback.set(convId, updated);
    return;
  }
  try {
    await r.set(key(convId), updated, { ex: TTL_SECONDS });
  } catch (err) {
    console.error("appendHistory: redis write failed:", err);
    memFallback.set(convId, updated);
  }
}
