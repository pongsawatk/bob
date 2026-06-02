// Central env access — fail fast with a clear message if a required key is missing.

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function opt(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const env = {
  // OpenRouter
  OPENROUTER_API_KEY: req("OPENROUTER_API_KEY"),
  MODEL_ROUTER:  opt("MODEL_ROUTER",  "google/gemini-3.1-flash-lite"),
  MODEL_HR:      opt("MODEL_HR",      "anthropic/claude-sonnet-4-6"),
  MODEL_GENERAL: opt("MODEL_GENERAL", "google/gemini-3.1-flash-lite"),
  MODEL_PRODUCT: opt("MODEL_PRODUCT", "anthropic/claude-sonnet-4-6"),
  MODEL_ASYNC:   opt("MODEL_ASYNC",   "deepseek/deepseek-v4-flash"),

  // Langfuse (optional — bot still works without it)
  LANGFUSE_PUBLIC_KEY: opt("LANGFUSE_PUBLIC_KEY"),
  LANGFUSE_SECRET_KEY: opt("LANGFUSE_SECRET_KEY"),
  LANGFUSE_HOST: opt("LANGFUSE_HOST", "https://cloud.langfuse.com"),

  // Upstash (optional — Phase 2)
  UPSTASH_REDIS_REST_URL:   opt("UPSTASH_REDIS_REST_URL"),
  UPSTASH_REDIS_REST_TOKEN: opt("UPSTASH_REDIS_REST_TOKEN"),

  // Outline
  OUTLINE_BASE_URL:       opt("OUTLINE_BASE_URL", "https://outline.builk.id"),
  OUTLINE_API_TOKEN:      opt("OUTLINE_API_TOKEN"),
  OUTLINE_COLLECTION_IDS: opt("OUTLINE_COLLECTION_IDS"),

  // KB admin — emails allowed to run /refresh in Teams (comma-separated)
  KB_ADMIN_EMAILS: opt("KB_ADMIN_EMAILS"),

  // Azure Bot
  AZURE_BOT_ID:     opt("AZURE_BOT_ID"),
  AZURE_BOT_SECRET: opt("AZURE_BOT_SECRET"),
  AZURE_TENANT_ID:  opt("AZURE_TENANT_ID"),
} as const;
