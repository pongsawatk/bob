// Simple test endpoint — POST /api/chat {"message":"..."}
// ใช้ทดสอบ pipeline โดยตรงโดยไม่ผ่าน Teams/Azure auth
// ลบ endpoint นี้ออกได้เมื่อ Teams ทำงานได้แล้ว
import type { VercelRequest, VercelResponse } from "@vercel/node";
import "../src/env.js";
import { runPipeline } from "../src/pipeline/index.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, hint: "POST {message, userId?, userName?}" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
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
