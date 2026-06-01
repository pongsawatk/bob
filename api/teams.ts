// Vercel Function entry point — /api/teams
// Azure Bot Framework POSTs every Teams message here.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import "../src/env.js"; // ensure env is validated at startup
import { handleTeamsRequest } from "../src/channels/teams.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "BOB Sidekick", version: "v2" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  await handleTeamsRequest(req as never, res as never);
}
