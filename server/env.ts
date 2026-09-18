/**
 * Server configuration.
 *
 * Every provider credential is read here and nowhere else. Nothing in `src/`
 * may import this file: the browser bundle must never be able to reach a key.
 */
export const env = {
  port: Number(process.env["PORT"] ?? 8787),
  databasePath: process.env["DOGFIGHT_DB"] ?? "data/dogfight.sqlite",

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
