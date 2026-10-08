import { randomUUID, createHash } from 'node:crypto';
import { getRedis } from '../store/redis.js';

const localLocks = new Set<string>();
const localDone = new Map<string, number>();
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
/** Serializes a conversation across instances and claims a Teams delivery once. */
export async function withConversationTurn(convId: string, activityId: string, fn: () => Promise<void>, waitMs = 30000): Promise<'completed' | 'duplicate' | 'busy'> {
  const r = getRedis(); const lock = `bob:turn:lock:${digest(convId)}`;
  const marker = `bob:turn:done:${digest(`${convId}:${activityId}`)}`;
  const token = randomUUID(); const deadline = Date.now() + waitMs;
  let acquired = false;
  while (!acquired) {
    if (r) acquired = Boolean(await r.set(lock, token, { nx: true, ex: 60 }));
    else if (!localLocks.has(lock)) { localLocks.add(lock); acquired = true; }
    if (!acquired) {
      if (Date.now() >= deadline) return 'busy';
      await new Promise(resolve => setTimeout(resolve, 75));
    }
  }
  try {
    if (activityId) {
      if (r) { if (!await r.set(marker, 'claimed', { nx: true, ex: 86400 })) return 'duplicate'; }
      else {
        for (const [k, until] of localDone) if (until < Date.now()) localDone.delete(k);
        if (localDone.has(marker)) return 'duplicate';
        localDone.set(marker, Date.now() + 86400000);
      }
    }
    await fn();
    return 'completed';
  } finally {
    if (r) await r.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", [lock], [token]).catch(() => console.warn('[turn] lease release failed; expires automatically'));
    else localLocks.delete(lock);
  }
}
