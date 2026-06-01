import { callLLM, type LLMResult } from "../llm/openrouter.js";
import { getPrompt } from "../prompts/langfusePrompts.js";
import { getHRBundle, getProductBundle } from "../kb/inline.js";
import { env } from "../env.js";
import type { Category } from "./router.js";

export interface DomainResult extends LLMResult {
  category: Category;
}

const CLARIFY_RESPONSE =
  "ขออภัยครับ ช่วยอธิบายเพิ่มเติมได้ไหมครับ?\n" +
  "ผมตอบเรื่อง HR (สวัสดิการ ลา OT เบิกเงิน) และ Product (Insite, Pojjaman, Builk360, JUBILI) ครับ";

export async function callDomainBot(
  category: Category,
  message: string,
  userName = "คุณ",
  department = ""
): Promise<DomainResult> {
  if (category === "UNKNOWN") {
    return {
      category,
      text: CLARIFY_RESPONSE,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  if (category === "HR") {
    const template = await getPrompt("hr");
    const kb = getHRBundle();
    const systemPrompt = template.replace("{{KB_BUNDLE}}", kb);

    const result = await callLLM({
      model: env.MODEL_HR,
      systemPrompt,
      messages: [{ role: "user", content: message }],
      maxTokens: 1000,
      temperature: 0.3,
      cacheSystem: env.MODEL_HR.startsWith("anthropic/"),
    });
    return { ...result, category };
  }

  if (category === "PRODUCT") {
    const template = await getPrompt("product");
    const kb = getProductBundle();
    const systemPrompt = template
      .replace("{{KB_BUNDLE}}", kb)
      .replace("{{user_name}}", userName)
      .replace("{{department}}", department);

    const result = await callLLM({
      model: env.MODEL_PRODUCT,
      systemPrompt,
      messages: [{ role: "user", content: message }],
      maxTokens: 2000,
      temperature: 0.5,
      cacheSystem: env.MODEL_PRODUCT.startsWith("anthropic/"),
    });
    return { ...result, category };
  }

  // GENERAL
  const template = await getPrompt("general");
  const systemPrompt = template.replace("{{user_message}}", "").trimEnd();
  const result = await callLLM({
    model: env.MODEL_GENERAL,
    systemPrompt,
    messages: [{ role: "user", content: message }],
    maxTokens: 800,
    temperature: 0.5,
  });
  return { ...result, category };
}
