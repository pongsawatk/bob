import { env } from "../env.js";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMCallOptions {
  model: string;
  systemPrompt: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** แนบ cache_control: ephemeral บน system prompt (ใช้กับ Anthropic models) */
  cacheSystem?: boolean;
}

export interface LLMResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Actual cost in USD as billed by OpenRouter (0 if not reported). */
  costUsd: number;
  latencyMs: number;
}

export async function callLLM(opts: LLMCallOptions): Promise<LLMResult> {
  const {
    model,
    systemPrompt,
    messages,
    maxTokens = 1000,
    temperature = 0.3,
    cacheSystem = false,
  } = opts;

  // OpenRouter /v1/chat/completions is OpenAI-compatible — system must be a string.
  // cache_control array format is Anthropic-native only and silently dropped here.
  // TODO Phase 2: switch to Anthropic native API for prompt caching when KB is large.
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    // Ask OpenRouter to report the actual cost (credits) it charged for this call.
    usage: { include: true },
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "BOB Sidekick",
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cost?: number;
    };
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  const u = json.usage ?? {};
  const details = u.prompt_tokens_details ?? {};

  return {
    text,
    latencyMs,
    costUsd: u.cost ?? 0,
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? details.cached_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
