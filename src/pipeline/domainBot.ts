import { callLLM, type LLMResult, type LLMMessage } from "../llm/openrouter.js";
import { getPrompt } from "../prompts/langfusePrompts.js";
import { getHRBundle, getProductBundle } from "../kb/index.js";
import { env } from "../env.js";
import type { Category } from "./router.js";

export interface DomainResult extends LLMResult {
  category: Category;
  /** OpenRouter model id that produced this answer ("" if no LLM was called). */
  model: string;
  /** Version of the prompt used ("v3"/"fallback", or "" if no LLM was called). */
  promptVersion: string;
}

const CLARIFY_RESPONSE =
  "ขออภัยครับ ช่วยอธิบายเพิ่มเติมได้ไหมครับ?\n" +
  "ผมตอบเรื่อง HR (สวัสดิการ ลา OT เบิกเงิน) และ Product (Insite, Pojjaman, Builk360, JUBILI) ครับ";

function currentDateTH(): string {
  return new Date().toLocaleDateString("th-TH", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Bangkok",
  });
}

export async function callDomainBot(
  category: Category,
  message: string,
  userName = "คุณ",
  department = "",
  history: LLMMessage[] = []
): Promise<DomainResult> {
  if (category === "UNKNOWN") {
    return {
      category,
      model: "",
      promptVersion: "",
      text: CLARIFY_RESPONSE,
      latencyMs: 0,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  if (category === "HR") {
    const { text: template, version: promptVersion } = await getPrompt("hr");
    const kb = await getHRBundle();
    const systemPrompt = template
      .replace("{{KB_BUNDLE}}", kb)
      .replace("{{CURRENT_DATE}}", currentDateTH());

    const result = await callLLM({
      model: env.MODEL_HR,
      systemPrompt,
      messages: [...history, { role: "user", content: message }],
      maxTokens: 1000,
      temperature: 0.3,
      cacheSystem: env.MODEL_HR.startsWith("anthropic/"),
    });
    return { ...result, category, model: env.MODEL_HR, promptVersion };
  }

  if (category === "PRODUCT") {
    const { text: template, version: promptVersion } = await getPrompt("product");
    const kb = await getProductBundle();
    const systemPrompt = template
      .replace("{{KB_BUNDLE}}", kb)
      .replace("{{user_name}}", userName)
      .replace("{{department}}", department)
      .replace("{{CURRENT_DATE}}", currentDateTH());

    const result = await callLLM({
      model: env.MODEL_PRODUCT,
      systemPrompt,
      messages: [...history, { role: "user", content: message }],
      maxTokens: 2000,
      temperature: 0.5,
      cacheSystem: env.MODEL_PRODUCT.startsWith("anthropic/"),
    });
    return { ...result, category, model: env.MODEL_PRODUCT, promptVersion };
  }

  // GENERAL
  const { text: template, version: promptVersion } = await getPrompt("general");
  const systemPrompt = template.replace("{{user_message}}", "").trimEnd();
  const result = await callLLM({
    model: env.MODEL_GENERAL,
    systemPrompt,
    messages: [...history, { role: "user", content: message }],
    maxTokens: 800,
    temperature: 0.5,
  });
  return { ...result, category, model: env.MODEL_GENERAL, promptVersion };
}
