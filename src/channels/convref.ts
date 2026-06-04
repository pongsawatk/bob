// Conversation references for proactive (bot-initiated) messaging.
// Captured when a user installs BOB or sends a message, and stored in Redis so
// any process (the bot itself, or a one-off script) can later message the user
// first via adapter.continueConversation. Keyed by the user's AAD object id.

import { getRedis } from "../store/redis.js";
import type { ConversationReference } from "botbuilder";

const TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days — refreshed on every interaction
const memFallback = new Map<string, Partial<ConversationReference>>();

function key(userId: string): string {
  return `bob:convref:${userId}`;
}

export async function saveConvRef(
  userId: string,
  ref: Partial<ConversationReference>
): Promise<void> {
  const r = getRedis();
  if (!r) {
    memFallback.set(userId, ref);
    return;
  }
  try {
    await r.set(key(userId), ref, { ex: TTL_SECONDS });
  } catch (err) {
    console.error("saveConvRef: redis write failed:", err);
    memFallback.set(userId, ref);
  }
}

export async function loadConvRef(
  userId: string
): Promise<Partial<ConversationReference> | null> {
  const r = getRedis();
  if (!r) return memFallback.get(userId) ?? null;
  try {
    return (await r.get<Partial<ConversationReference>>(key(userId))) ?? null;
  } catch (err) {
    console.error("loadConvRef: redis read failed:", err);
    return memFallback.get(userId) ?? null;
  }
}
