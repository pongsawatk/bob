import { callLLM, type LLMMessage } from "../llm/openrouter.js";
import { getPrompt } from "../prompts/langfusePrompts.js";
import { env } from "../env.js";

export type Category = "HR" | "PRODUCT" | "GENERAL" | "UNKNOWN";

export interface RouterResult {
  category: Category;
  confidence: number;
  needsClarification: boolean;
  rawJson: string;
  // Observability — lets the pipeline log the router as a Langfuse generation.
  model: string;
  promptVersion: string;
  latencyMs: number;
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number };
}

export async function routeMessage(message: string, history: LLMMessage[] = []): Promise<RouterResult> {
  const { text: promptTemplate, version: promptVersion } = await getPrompt("router");
  const systemPrompt = promptTemplate.replace("{{user_message}}", message);

  // Include recent conversation context so router understands follow-up questions
  const historyContext = history.length > 0
    ? history.slice(-4).map(m => `${m.role === "user" ? "ผู้ใช้" : "BOB"}: ${m.content}`).join("\n") + "\n\n"
    : "";

  const userMsg = `${historyContext}คำถามล่าสุด: ${message}\n\nตอบเป็น JSON เท่านั้น: {"category":"HR|PRODUCT|GENERAL|UNKNOWN","confidence":0.0-1.0,"needs_clarification":boolean}`;

  const result = await callLLM({
    model: env.MODEL_ROUTER,
    systemPrompt,
    messages: [{ role: "user", content: userMsg }],
    maxTokens: 60,
    temperature: 0.0,
  });

  const raw = result.text.trim();
  const meta = {
    model: env.MODEL_ROUTER,
    promptVersion,
    latencyMs: result.latencyMs,
    costUsd: result.costUsd,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };

  // Parse JSON — be defensive
  try {
    // Strip markdown code fences if model wraps in ```json
    const clean = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(clean) as {
      category?: string;
      confidence?: number;
      needs_clarification?: boolean;
    };
    const validCategories: Category[] = ["HR", "PRODUCT", "GENERAL", "UNKNOWN"];
    const category =
      validCategories.includes(parsed.category as Category)
        ? (parsed.category as Category)
        : "UNKNOWN";

    return {
      category,
      confidence: parsed.confidence ?? 0.5,
      needsClarification: parsed.needs_clarification ?? false,
      rawJson: raw,
      ...meta,
    };
  } catch {
    // If parsing fails, default to UNKNOWN
    return { category: "UNKNOWN", confidence: 0, needsClarification: true, rawJson: raw, ...meta };
  }
}
