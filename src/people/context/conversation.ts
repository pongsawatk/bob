import { createHash } from 'node:crypto';
import { getRedis } from '../../store/redis.js';
import type { IntentResult } from '../pcTypes.js';

export interface PeopleConversation {
  version: 1;
  at: number;
  requests: IntentResult[];
  /** References only. Every next turn resolves again against the current directory. */
  shown: string[];
  pending: string[];
  pendingRequest?: IntentResult;
  served: number;
}
const TTL = 30 * 60;
export function peopleContextKey(userId: string, sessionId: string): string {
  return 'bob:people:context:v1:' + createHash('sha256').update(JSON.stringify([userId,sessionId])).digest('hex');
}
export async function readPeopleConversation(userId?: string, sessionId?: string): Promise<PeopleConversation | undefined> {
  if (!userId || !sessionId) return;
  try {
    const state = await getRedis()?.get<PeopleConversation>(peopleContextKey(userId,sessionId));
    if (state?.version === 1 && Date.now() - state.at < TTL * 1000 && state.requests.length <= 4) return state;
  } catch { /* Missing context must never lead to a guessed person. */ }
}
export async function writePeopleConversation(userId: string | undefined, sessionId: string | undefined, state?: PeopleConversation): Promise<void> {
  if (!userId || !sessionId) return;
  try {
    const redis = getRedis();
    if (state) await redis?.set(peopleContextKey(userId,sessionId),state,{ ex: TTL });
    else await redis?.del(peopleContextKey(userId,sessionId));
  } catch { /* The next turn can ask again if the context store is unavailable. */ }
}

/** Only short, recognizable references may bypass a redundant router clarification. */
export function isPeopleFollowUp(query: string, state?: PeopleConversation): boolean {
  query=query.replace(/ขอ\s+/g,'ขอ').replace(/\s+ด้วย/g,'ด้วย');
  if (!state || query.length > 160) return false;
  return /^(?:มีใครบ้าง|ใครบ้าง|ขอ(?:ราย)?ชื่อ(?:ด้วย)?|ขอ(?:อีเมล|อีเมล์|เมล|เมล์|email|e-mail)(?:ด้วย)?|ดูต่อ|มี(?:คนอื่น|อีก)|คน(?:ที่|แรก|สุดท้าย|\s)|เอา(?:คน|เฉพาะ)|ไม่ใช่|แล้ว.{1,50}(?:ล่ะ|ละ)|หัวหน้า(?:ของ)?(?:เขา|คนนี้)|แล้วใครดูแลภาพรวม)/i.test(query.trim())
    || (!!state.pending.length && /^(?:IT|HR|คน|ฝั่ง|ทีม|แผนก|[1-5](?:\s|$))/i.test(query.trim()));
}
