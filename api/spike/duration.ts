// G1 SPIKE (DRAFT) — measure real Vercel function duration + whether detached work
// survives after the response. Decides the /insight job architecture: run inline in
// the handler, or hand off to a durable queue (QStash) because 60s isn't enough.
//
// Deploy this route, then (CRON_SECRET required — nobody can trigger it by URL):
//   sync mode  — blocks in the handler, heartbeating to Redis every 3s up to 120s.
//     curl -H "Authorization: Bearer $CRON_SECRET" "$URL/api/spike/duration?mode=sync&run=A"
//     → if the client gets a 504 and Redis stops at ~57–60s, the maxDuration cap is real.
//   detach mode — returns immediately, then keeps heartbeating WITHOUT awaiting.
//     curl -H "Authorization: Bearer $CRON_SECRET" "$URL/api/spike/duration?mode=detach&run=B"
//     → if Redis heartbeats stop right after the response, detached work is frozen →
//       we MUST use a queue, not fire-and-forget.
//   waituntil mode — same as detach, but registers the promise via Vercel's official
//   @vercel/functions#waitUntil instead of a bare unawaited call.
//     curl -H "Authorization: Bearer $CRON_SECRET" "$URL/api/spike/duration?mode=waituntil&run=C"
//     → if THIS survives (unlike plain detach) it's a usable primitive for /insight;
//       if it also freezes, the platform doesn't extend Node.js Serverless Functions
//       (only Edge/Next.js), and a durable queue (QStash) is required.
//   read — dump what actually got written.
//     curl -H "Authorization: Bearer $CRON_SECRET" "$URL/api/spike/duration?read=A"
//
// SAFE: writes only to spike:duration:* keys (60-min TTL); no user-facing effect.
// REMOVE after the spike — this is not production code.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { env } from "../../src/env.js";
import { getRedis } from "../../src/store/redis.js";

export const config = { maxDuration: 60 }; // bump to test whether the plan allows more

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hbKey = (run: string) => `spike:duration:${run}`;

async function heartbeat(run: string, budgetMs: number): Promise<number> {
  const r = getRedis();
  const t0 = Date.now();
  let last = 0;
  for (let elapsed = 0; elapsed <= budgetMs; elapsed = Date.now() - t0) {
    last = Math.round(elapsed / 1000);
    if (r) await r.set(hbKey(run), { lastElapsedS: last, at: new Date().toISOString() }, { ex: 3600 });
    await sleep(3000);
  }
  return last;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const q = req.query as Record<string, string>;
  const run = q.run || "default";
  const r = getRedis();

  if (q.read) {
    const hb = r ? await r.get(hbKey(q.read)) : null;
    res.status(200).json({ run: q.read, heartbeat: hb });
    return;
  }

  if (q.mode === "detach") {
    // Fire-and-forget: NOT awaited. On a plain serverless function this is expected
    // to be frozen once the response is sent — the point is to prove that.
    void heartbeat(run, 120_000);
    res.status(200).json({ ok: true, mode: "detach", run, note: "returned immediately; read back to see if heartbeats continued" });
    return;
  }

  if (q.mode === "waituntil") {
    // Same background work, but registered with Vercel's official primitive for
    // "keep running after the response" instead of a bare unawaited call.
    waitUntil(heartbeat(run, 120_000));
    res.status(200).json({ ok: true, mode: "waituntil", run, note: "returned immediately; read back to see if heartbeats continued" });
    return;
  }

  // sync mode (default): block up to 120s. Vercel kills at maxDuration → the last
  // Redis heartbeat reveals the true cap.
  const reached = await heartbeat(run, 120_000);
  res.status(200).json({ ok: true, mode: "sync", run, reachedSeconds: reached });
}
