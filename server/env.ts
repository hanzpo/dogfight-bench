/**
 * Server configuration.
 *
 * Every provider credential is read here and nowhere else. Nothing in `src/`
 * may import this file: the browser bundle must never be able to reach a key.
 */
export const env = {
  port: Number(process.env["PORT"] ?? 8787),
  host: process.env["HOST"] ?? "127.0.0.1",
  databasePath: process.env["DOGFIGHT_DB"] ?? "data/dogfight.sqlite",

  /**
   * Shared secret for the endpoints that spend money.
   *
   * `/api/decide` and `/api/matches` call paid providers on this server's
   * credentials, so an open deployment is an open invitation to spend someone
   * else's inference budget. When this is set it is required; when it is not,
   * the server refuses to expose those endpoints beyond localhost.
   */
  apiToken: process.env["DOGFIGHT_API_TOKEN"],
  /** Comma-separated origins allowed to call the API cross-origin. */
  allowedOrigins: (process.env["DOGFIGHT_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  /** Directory of the built viewer, served by this process in production. */
  staticDir: process.env["DOGFIGHT_STATIC_DIR"] ?? "dist",
  /** Most matches one `/api/matches` request may run. */
  maxSeriesRounds: Number(process.env["DOGFIGHT_MAX_ROUNDS"] ?? 10),

  anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
  anthropicModel: process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5",
  /** Reasoning effort for the flight model. Low keeps a decision inside a second. */
  anthropicEffort: (process.env["ANTHROPIC_EFFORT"] ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",

  /** Any OpenAI-compatible endpoint: OpenAI, Groq, OpenRouter, Ollama, vLLM. */
  openaiApiKey: process.env["OPENAI_API_KEY"],
  openaiBaseUrl: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
  openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-4.1-mini",

  typesafeApiKey: process.env["TYPESAFE_API_KEY"],
  typesafeModel: process.env["TYPESAFE_MODEL"] ?? "jev-latest",
  typesafeUrl: process.env["TYPESAFE_URL"] ?? "https://api.typesafe.ai/v1/systemone",

  /** Per-decision wall-clock deadline handed to the simulation. */
  decisionTimeoutMs: Number(process.env["DECISION_TIMEOUT_MS"] ?? 4_000),
  /** Simulated seconds between decisions. Raise it for slower models. */
  decisionIntervalS: Number(process.env["DECISION_INTERVAL_S"] ?? 1),
  /** Abandon a match if one agent spends more than this on inference. */
  inferenceBudgetUsd: Number(process.env["INFERENCE_BUDGET_USD"] ?? 2),
} as const;

export function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set; this provider is unavailable`);
  return value;
}
