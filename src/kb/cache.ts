// Phase 2: Shared bundle cache in Upstash Redis.
// Vercel is stateless — Redis lets every serverless invocation read the same
// pre-assembled bundle without re-hitting Outline on each request.

import { Redis } from "@upstash/redis";
import { env } from "../env.js";
import type { Bundles } from "./outline.js";

const BUNDLES_KEY = "bob:kb:bundles";
const META_KEY = "bob:kb:meta";

export interface KbMeta {
  refreshedAt: string;
  counts: { hr: number; process: number; product: number };
}

let _redis: Redis | null = null;

function redis(): Redis | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!_redis) {
    _redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return _redis;
}

export function redisConfigured(): boolean {
  return redis() !== null;
}

export async function readBundlesFromRedis(): Promise<Bundles | null> {
  const r = redis();
  if (!r) return null;
  return (await r.get<Bundles>(BUNDLES_KEY)) ?? null;
}

export async function writeBundlesToRedis(bundles: Bundles, meta: KbMeta): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Upstash Redis is not configured (UPSTASH_REDIS_REST_URL/TOKEN)");
  await r.set(BUNDLES_KEY, bundles);
  await r.set(META_KEY, meta);
}

export async function readMetaFromRedis(): Promise<KbMeta | null> {
  const r = redis();
  if (!r) return null;
  return (await r.get<KbMeta>(META_KEY)) ?? null;
}
