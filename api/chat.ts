// Test endpoint — POST /api/chat {"message":"..."} with header x-test-key.
// ใช้ทดสอบ pipeline โดยตรงโดยไม่ผ่าน Teams/Azure auth.
// ต้องตั้ง CHAT_TEST_KEY (Vercel env) และส่ง header ให้ตรง — ไม่ตั้ง = ปิด endpoint
// (เดิมเปิด public ใครก็ยิงได้ = เผา OpenRouter credit ได้ไม่จำกัด)
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../src/env.js";
import { runPipeline } from "../src/pipeline/index.js";
import { prepareITSnapshot, writeITSnapshot, getITBundle } from '../src/kb/it.js';

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
  // Authenticated release check runs with the actual production Outline/Redis
  // credentials. No document bodies or credentials leave this endpoint.
  if (req.body?.action === 'refresh-it') {
    try {
      const snapshot = await prepareITSnapshot();
      await writeITSnapshot(snapshot);
      if (!(await getITBundle())) throw new Error('IT cache read-back failed');
      res.status(200).json({ ok: true, collectionId: snapshot.collectionId,
        documents: snapshot.docs.length, refreshedAt: snapshot.refreshedAt });
    } catch {
      res.status(503).json({ ok: false, error: 'IT source refresh failed; check production Outline/Redis access' });
    }
    return;
  }
  const history = req.body?.history;
  if (history !== undefined && (!Array.isArray(history) || history.length > 14 || history.some(m =>
    !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 10000))) {
    res.status(400).json({ error: 'Invalid test conversation history' }); return;
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
      channel: 'test',
      userId: userId ?? "test-user",
      userName: userName ?? "Tester",
      department: department ?? "",
      history,
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
