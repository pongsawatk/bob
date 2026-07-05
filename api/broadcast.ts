// Vercel Cron target — POST/GET /api/broadcast
// Fires daily (see vercel.json) but only SENDS when armed: BROADCAST_CAMPAIGN
// must name a campaign that has a prebuilt roster. Idempotent per recipient, so
// re-firing the same armed day never double-sends. Disarm by clearing the env.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../src/env.js";
import { runBroadcast } from "../src/channels/broadcast.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only the Vercel cron (or someone holding CRON_SECRET) may trigger a mass DM.
  const auth = req.headers.authorization ?? "";
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!env.BROADCAST_CAMPAIGN) {
    res.status(200).json({ ok: true, disarmed: true, note: "BROADCAST_CAMPAIGN not set — no-op" });
    return;
  }
  try {
    const result = await runBroadcast(env.BROADCAST_CAMPAIGN);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
}
