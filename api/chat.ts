// Test endpoint — POST /api/chat {"message":"..."} with header x-test-key.
// ใช้ทดสอบ pipeline โดยตรงโดยไม่ผ่าน Teams/Azure auth.
// ต้องตั้ง CHAT_TEST_KEY (Vercel env) และส่ง header ให้ตรง — ไม่ตั้ง = ปิด endpoint
// (เดิมเปิด public ใครก็ยิงได้ = เผา OpenRouter credit ได้ไม่จำกัด)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../src/env.js";
import { runPipeline } from "../src/pipeline/index.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, hint: "POST {message, userId?, userName?} + header x-test-key" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!env.CHAT_TEST_KEY || req.headers["x-test-key"] !== env.CHAT_TEST_KEY) {
    res.status(401).json({ error: "Unauthorized — set CHAT_TEST_KEY and send x-test-key header" });
    return;
  }
  const { message, userId, userName, department } = req.body as {
    message?: string;
    userId?: string;
    userName?: string;
    department?: string;
  };
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  try {
    const result = await runPipeline({
      message,
      userId: userId ?? "test-user",
      userName: userName ?? "Tester",
      department: department ?? "",
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
