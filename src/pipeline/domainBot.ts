import { callLLM, type LLMResult, type LLMMessage } from "../llm/openrouter.js";
import { getPrompt } from "../prompts/langfusePrompts.js";
import { getHRBundle, getProductBundle } from "../kb/index.js";
import { remainingHolidaysBlock } from "../kb/holidays.js";
import { selectDocs, type SelectResult } from "../kb/select.js";
import { env } from "../env.js";
import type { Category } from "./router.js";

export interface DomainResult extends LLMResult {
  category: Category;
  /** OpenRouter model id that produced this answer ("" if no LLM was called). */
  model: string;
  /** Version of the prompt used ("v3"/"fallback", or "" if no LLM was called). */
  promptVersion: string;
  /** Time fetching the domain prompt (getPrompt) — for latency-overhead profiling. */
  promptMs: number;
  /** Time assembling the KB bundle (getHRBundle/getProductBundle) — 0 for GENERAL. */
  kbMs: number;
  /** KB retrieval stats (HR only) — how much of the bundle was sent this turn. */
  kbSelect?: SelectResult;
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
  history: LLMMessage[] = [],
  profileBlock?: string
): Promise<DomainResult> {
  if (category === "UNKNOWN") {
    return {
      category,
      model: "",
      promptVersion: "",
      promptMs: 0,
      kbMs: 0,
      text: CLARIFY_RESPONSE,
      latencyMs: 0,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }

  if (category === "HR") {
    const tPrompt = Date.now();
    const { text: template, version: promptVersion } = await getPrompt("hr");
    const promptMs = Date.now() - tPrompt;
    const tKb = Date.now();
    // Trim the bundle to the docs relevant to this question (see kb/select.ts).
    const kbSelect = selectDocs(message, await getHRBundle());
    const kbMs = Date.now() - tKb;
    // Inject today's date PLUS a precomputed "remaining holidays" list so the model
    // reports it instead of doing (error-prone) date arithmetic. See kb/holidays.ts.
    const holidays = remainingHolidaysBlock();
    const dateBlock = holidays ? `${currentDateTH()}\n\n${holidays}` : currentDateTH();
    const systemPrompt = template
      .replace("{{KB_BUNDLE}}", kbSelect.bundle)
      .replace("{{CURRENT_DATE}}", dateBlock);

    const result = await callLLM({
      model: env.MODEL_HR,
      systemPrompt,
      messages: [...history, { role: "user", content: message }],
      // 1300, not 1000: enumerate answers ("สวัสดิการมีอะไรบ้าง") hit the old cap
      // mid-sentence ~13×/week. Prompt length rules still target 80-150 words.
      maxTokens: 1300,
      temperature: 0.3,
      cacheSystem: env.MODEL_HR.startsWith("anthropic/"),
      userContext: profileBlock,
    });
    return { ...result, category, model: env.MODEL_HR, promptVersion, promptMs, kbMs, kbSelect };
  }

  if (category === "PRODUCT") {
    const tPrompt = Date.now();
    const { text: template, version: promptVersion } = await getPrompt("product");
    const promptMs = Date.now() - tPrompt;
    const tKb = Date.now();
    const kb = await getProductBundle();
    const kbMs = Date.now() - tKb;
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
      userContext: profileBlock,
    });
    return { ...result, category, model: env.MODEL_PRODUCT, promptVersion, promptMs, kbMs };
  }

  // GENERAL
  const tPrompt = Date.now();
  const { text: template, version: promptVersion } = await getPrompt("general");
  const promptMs = Date.now() - tPrompt;
  const systemPrompt = template.replace("{{user_message}}", "").trimEnd();
  // GENERAL gets the profile too — "คุณรู้จักผมไหม" routes here, and identity
  // questions answered with "ไม่รู้จักคุณ" undercut the whole feature.
  const result = await callLLM({
    model: env.MODEL_GENERAL,
    systemPrompt,
    messages: [...history, { role: "user", content: message }],
    maxTokens: 800,
    temperature: 0.5,
    userContext: profileBlock,
  });
  return { ...result, category, model: env.MODEL_GENERAL, promptVersion, promptMs, kbMs: 0 };
}
