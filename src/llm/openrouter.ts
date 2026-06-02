import { env } from "../env.js";
import { fetchRetry } from "../http/fetchRetry.js";

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

  // For Anthropic models, cache the (large, stable) system prompt by sending it as a
  // content-block array with cache_control:ephemeral — OpenRouter passes this through
  // to Anthropic. Cached input tokens are billed at 0.25x. For non-Anthropic models
  // (Gemini) we send a plain string. ephemeral TTL is ~5 min, so the date in the
  // prompt is stable within a cache window; HR (no per-user data) is shared across
  // users, Product is shared across a user's multi-turn follow-ups.
  const systemContent = cacheSystem
    ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
    : systemPrompt;

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    // Ask OpenRouter to report the actual cost (credits) it charged for this call.
    usage: { include: true },
    messages: [
      { role: "system", content: systemContent as unknown },
      ...messages.map((m) => ({ role: m.role, content: m.content as unknown })),
    ],
  };

  const t0 = Date.now();
  // 50s per-attempt timeout (normal answers are 5-20s; below Vercel's 60s limit).
  // Retries only fire on fast 429/5xx/network errors, not on timeouts.
  const res = await fetchRetry(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "BOB Sidekick",
      },
      body: JSON.stringify(body),
    },
    { retries: 2, timeoutMs: 50_000 }
  );
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
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
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
      cacheWriteTokens: u.cache_creation_input_tokens ?? details.cache_write_tokens ?? 0,
    },
  };
}
