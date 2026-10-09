import { env } from "../env.js";
import { fetchRetry } from "../http/fetchRetry.js";
import { acceptsTemperature, type Effort } from './modelConfig.js';

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
  effort?: Effort;
  /** Evaluation fixes providers and forbids unnoticed provider fallbacks. */
  providers?: string[];
  strictProvider?: boolean;
  maxPrice?: { prompt: number; completion: number };
  timeoutMs?: number;
  retries?: number;
  /** แนบ cache_control: ephemeral บน system prompt (ใช้กับ Anthropic models) */
  cacheSystem?: boolean;
  /**
   * Per-user context (e.g. the asker's profile) appended as a SEPARATE system
   * block AFTER the cached one. Never gets cache_control — a per-user prefix
   * inside the cached block would break the shared cache for everyone.
   */
  userContext?: string;
}

export interface LLMResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number;
  };
  /** Null means the provider did not report billing; never treat it as free. */
  costUsd: number | null;
  latencyMs: number;
  requestedModel?: string;
  actualModel?: string;
  provider?: string;
  responseId?: string;
  requestedEffort?: Effort;
  effectiveEffort?: string;
  finishReason?: string;
  fallbackFrom?: string;
  promptHash?: string;
  kbHash?: string;
}

export function buildLLMBody(opts: LLMCallOptions) {
  const { model, systemPrompt, messages, maxTokens = 1000, cacheSystem = false, userContext } = opts;
  const systemContent = cacheSystem && model.startsWith('anthropic/')
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ...(userContext ? [{ type: 'text', text: userContext }] : [])]
    : [systemPrompt, userContext].filter(Boolean).join('\n\n');
  return {
    model, max_tokens: maxTokens, usage: { include: true },
    ...(acceptsTemperature(model) && opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.effort ? { reasoning: { effort: opts.effort, exclude: true } } : {}),
    ...(opts.effort || opts.providers || opts.strictProvider || opts.maxPrice ? { provider: {
      require_parameters: true,
      ...(opts.providers?.length ? { only: opts.providers } : {}),
      ...(opts.strictProvider ? { allow_fallbacks: false } : {}),
      ...(opts.maxPrice ? { max_price: opts.maxPrice } : {}),
    } } : {}),
    messages: [{ role: 'system', content: systemContent as unknown }, ...messages],
  };
}

export async function callLLM(opts: LLMCallOptions): Promise<LLMResult> {
  const { model } = opts;
  const body = buildLLMBody(opts);

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
        "X-OpenRouter-Title": "BOB",
        "HTTP-Referer": "https://bob-sidekick.vercel.app",
        "X-OpenRouter-App-Visibility": "hidden",
      },
      body: JSON.stringify(body),
    },
    { retries: opts.retries ?? 2, timeoutMs: opts.timeoutMs ?? 50_000 }
  );

  if (!res.ok) {
    // Provider errors can echo request content. Keep logs free of that content.
    throw new Error(`OpenRouter HTTP ${res.status} (model ${model})`);
  }

  const json = (await res.json()) as {
    id?: string;
    model?: string;
    provider?: string;
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cost?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  // Measure AFTER res.json(): fetch() resolves `res` when response *headers*
  // arrive, but for these (non-streamed) LLM calls the body — i.e. the generated
  // answer — keeps downloading after that. Timing at headers undercounted the real
  // LLM round-trip by several seconds; reading the body first captures true latency.
  const latencyMs = Date.now() - t0;

  const text = json.choices?.[0]?.message?.content ?? "";
  // An empty completion used to flow through and reach Teams as a blank card.
  // Fail loudly instead: onTurnError sends a proper apology + fires the alert webhook.
  if (!text.trim()) throw new Error(`OpenRouter returned empty content (model ${model})`);
  const u = json.usage ?? {};
  const details = u.prompt_tokens_details ?? {};

  return {
    text,
    latencyMs,
    costUsd: typeof u.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null,
    requestedModel: model,
    actualModel: json.model,
    provider: json.provider,
    responseId: json.id,
    requestedEffort: opts.effort,
    // The gateway does not echo effective effort; requested is not proof of it.
    effectiveEffort: 'unknown',
    finishReason: json.choices?.[0]?.finish_reason ?? 'unknown',
    usage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? details.cached_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? details.cache_write_tokens ?? 0,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
    },
  };
}
