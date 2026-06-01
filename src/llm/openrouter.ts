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

  const isAnthropic = model.startsWith("anthropic/");

  // Build system content — Anthropic supports array + cache_control, others use string
  const systemContent: unknown = isAnthropic && cacheSystem
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    usage: { include: true },
    system: systemContent,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
    };
  };

  const text = json.choices?.[0]?.message?.content ?? "";
  const u = json.usage ?? {};
  const details = u.prompt_tokens_details ?? {};

  return {
    text,
    latencyMs,
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? details.cached_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
  };
}
