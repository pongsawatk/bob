// Conversation history keyed by Teams conversation id.
// Stored in Redis so it survives Vercel cold starts (an in-memory Map would
// reset between invocations and the bot would forget the previous turn).

import { getRedis } from "../store/redis.js";
import type { LLMMessage } from "../llm/openrouter.js";

const MAX_HISTORY_MESSAGES = 14; // 7 turns sent to the LLM
const TTL_SECONDS = 60 * 60 * 24; // conversation window: 24h of inactivity (sliding)

// Fallback for local dev / when Redis isn't configured.
const memFallback = new Map<string, LLMMessage[]>();
const epochs = new Map<string, number>();
export async function historyEpoch(convId: string): Promise<number> {
  const r = getRedis();
  return r ? await r.get<number>(`${key(convId)}:epoch`) ?? 0 : epochs.get(convId) ?? 0;
}

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
  assistantMessage: string,
  expectedEpoch?: number,
): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.eval(`
      local epoch = tonumber(redis.call('GET',KEYS[2]) or '0')
      if ARGV[4] ~= '' and epoch ~= tonumber(ARGV[4]) then return 0 end
      local raw = redis.call('GET',KEYS[1])
      local rows = raw and cjson.decode(raw) or {}
      table.insert(rows,{role='user',content=ARGV[1]})
      table.insert(rows,{role='assistant',content=ARGV[2]})
      while #rows > 14 do table.remove(rows,1) end
      redis.call('SET',KEYS[1],cjson.encode(rows),'EX',ARGV[3])
      return 1`, [key(convId), `${key(convId)}:epoch`], [userMessage, assistantMessage, TTL_SECONDS, expectedEpoch ?? '']);
    return;
  }
  if (expectedEpoch !== undefined && expectedEpoch !== (epochs.get(convId) ?? 0)) return;
  const prev = memFallback.get(convId) ?? [];
  const updated = [
    ...prev,
    { role: "user" as const, content: userMessage },
    { role: "assistant" as const, content: assistantMessage },
  ].slice(-MAX_HISTORY_MESSAGES);

  memFallback.set(convId, updated);
}

/** Forget a conversation (the user explicitly reset it). */
export async function clearHistory(convId: string): Promise<void> {
  memFallback.delete(convId);
  epochs.set(convId, (epochs.get(convId) ?? 0) + 1);
  const r = getRedis();
  if (!r) return;
  await r.eval("redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],172800); return redis.call('DEL',KEYS[1])", [key(convId), `${key(convId)}:epoch`], []);
}
