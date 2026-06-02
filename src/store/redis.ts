// Shared Upstash Redis client. Vercel is stateless across (and sometimes within)
// invocations, so anything that must survive cold starts lives here.

import { Redis } from "@upstash/redis";
import { env } from "../env.js";

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!_redis) {
    _redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}
