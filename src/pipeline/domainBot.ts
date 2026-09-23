import { callLLM, type LLMResult, type LLMMessage } from "../llm/openrouter.js";
import { getPrompt } from "../prompts/langfusePrompts.js";
import { getHRBundle, getProductBundle } from "../kb/index.js";
import { remainingHolidaysBlock } from "../kb/holidays.js";
import { selectDocs, type SelectResult } from "../kb/select.js";
import { env } from "../env.js";
import type { Category } from "./router.js";
import { guardEligibility } from '../prompts/systemPolicy.js';
import { timesheetEditGap } from '../kb/taskEvidence.js';
import { getITBundle, IT_COLLECTION_ID } from '../kb/it.js';
import { validateITAnswer, IT_UNAVAILABLE } from '../kb/itAnswer.js';
import { retrievalQuery } from '../kb/query.js';

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
  eligibilityGuarded?: boolean;
  evidenceGap?: 'timesheet_edit_workflow';
  itCollectionId?: string;
  citationGuarded?: boolean;
}

const CLARIFY_RESPONSE =
  "ขออภัยครับ ช่วยอธิบายเพิ่มเติมได้ไหมครับ?\n" +
  "ผมตอบเรื่อง HR (สวัสดิการ ลา OT เบิกเงิน), Product และ IT (VPN, เครื่องมือ AI, คู่มือใช้งานระบบ) ครับ";

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
  profileBlock?: string,
  kbSources: { getHRBundle: typeof getHRBundle; getProductBundle: typeof getProductBundle; getITBundle?: typeof getITBundle } = { getHRBundle, getProductBundle, getITBundle },
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
    const kbSelect = selectDocs(message, await kbSources.getHRBundle(), history);
    const kbMs = Date.now() - tKb;
    const gap = timesheetEditGap(message, kbSelect.bundle, history);
    if (gap) return { category, text: gap, model: '', promptVersion, promptMs, kbMs, kbSelect,
      evidenceGap: 'timesheet_edit_workflow', latencyMs: 0, costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
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
    const guarded = guardEligibility(result.text);
    return { ...result, text: guarded.text, eligibilityGuarded: guarded.guarded, category, model: env.MODEL_HR, promptVersion, promptMs, kbMs, kbSelect };
  }

  if (category === "PRODUCT") {
    const tPrompt = Date.now();
    const { text: template, version: promptVersion } = await getPrompt("product");
    const promptMs = Date.now() - tPrompt;
    const tKb = Date.now();
    const kb = await kbSources.getProductBundle();
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

  if (category === 'IT') {
    const tKb = Date.now();
    const kb = await (kbSources.getITBundle ?? getITBundle)();
    const kbMs = Date.now() - tKb;
    if (!kb) return { category, text: IT_UNAVAILABLE, model: '', promptVersion: '', promptMs: 0, kbMs,
      itCollectionId: IT_COLLECTION_ID, latencyMs: 0, costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const kbSelect = selectDocs(message, kb, history);
    const tPrompt = Date.now();
    const { text: template, version: promptVersion } = await getPrompt('it');
    const promptMs = Date.now() - tPrompt;
    const result = await callLLM({
      model: env.MODEL_IT,
      systemPrompt: template.replace('{{KB_BUNDLE}}', kbSelect.bundle).replace('{{CURRENT_DATE}}', currentDateTH()),
      // Only user topic context survives. Old assistant answers cannot become IT evidence.
      messages: [{ role: 'user', content: retrievalQuery(message, history) }],
      maxTokens: 2000, temperature: 0.1, cacheSystem: env.MODEL_IT.startsWith('anthropic/'),
    });
    const checked = validateITAnswer(result.text, kbSelect);
    return { ...result, text: checked.text, category, model: env.MODEL_IT, promptVersion, promptMs, kbMs,
      kbSelect, itCollectionId: IT_COLLECTION_ID, citationGuarded: checked.guarded };
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
