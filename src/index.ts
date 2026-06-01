// Local dev server — wraps the same pipeline without Vercel/Teams overhead.
// Usage: npm run dev
// Then: curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" \
//        -d '{"message":"ลาพักร้อนต้องทำยังไง"}'

import http from "node:http";
import "./env.js";
import { runPipeline } from "./pipeline/index.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "BOB Sidekick", version: "v2" }));
    return;
  }

  // Chat endpoint
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { message, userId, userName, department } = JSON.parse(body) as {
          message?: string;
          userId?: string;
          userName?: string;
          department?: string;
        };
        if (!message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "message is required" }));
          return;
        }
        const output = await runPipeline({
          message,
          userId: userId ?? "dev-user",
          userName: userName ?? "Dev",
          department: department ?? "",
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(output, null, 2));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`BOB Sidekick dev server → http://localhost:${PORT}`);
  console.log(`  POST /chat  { "message": "..." }`);
});
