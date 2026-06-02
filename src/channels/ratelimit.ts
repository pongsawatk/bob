// Per-user rate limit (Redis fixed window) to curb spam and runaway cost.
// Fail-open: if Redis is unavailable we allow the request rather than block users.

import { getRedis } from "../store/redis.js";

const LIMIT = 20; // messages
const WINDOW_SEC = 60; // per minute

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return { allowed: true, remaining: LIMIT };

  const key = `bob:rl:${userId}`;
  try {
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, WINDOW_SEC); // start the window on first hit
    return { allowed: count <= LIMIT, remaining: Math.max(0, LIMIT - count) };
  } catch (err) {
    console.error("checkRateLimit: redis failed, allowing:", err);
    return { allowed: true, remaining: LIMIT };
  }
}
