import { callLLM } from "../llm/openrouter.js";
import { getPrompt } from "../prompts/langfusePrompts.js";
import { env } from "../env.js";

export type Category = "HR" | "PRODUCT" | "GENERAL" | "UNKNOWN";

export interface RouterResult {
  category: Category;
  confidence: number;
  needsClarification: boolean;
  rawJson: string;
}

export async function routeMessage(message: string): Promise<RouterResult> {
  const promptTemplate = await getPrompt("router");
  const systemPrompt = promptTemplate.replace("{{user_message}}", message);

  // User message explicitly requests JSON to reinforce instruction (helps Flash Lite)
  const userMsg = `คำถาม: ${message}\n\nตอบเป็น JSON เท่านั้น: {"category":"HR|PRODUCT|GENERAL|UNKNOWN","confidence":0.0-1.0,"needs_clarification":boolean}`;

  const result = await callLLM({
    model: env.MODEL_ROUTER,
    systemPrompt,
    messages: [{ role: "user", content: userMsg }],
    maxTokens: 60,
    temperature: 0.0,
  });

  const raw = result.text.trim();

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
    };
  } catch {
    // If parsing fails, default to UNKNOWN
    return { category: "UNKNOWN", confidence: 0, needsClarification: true, rawJson: raw };
  }
}
