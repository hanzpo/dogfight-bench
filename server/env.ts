export const env = {
  port: Number(process.env["PORT"] ?? 8787),
  host: process.env["HOST"] ?? "127.0.0.1",
  databasePath: process.env["DOGFIGHT_DB"] ?? "data/dogfight.sqlite",

  apiToken: process.env["DOGFIGHT_API_TOKEN"],
  allowedOrigins: (process.env["DOGFIGHT_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicProviders: (process.env["DOGFIGHT_PUBLIC_PROVIDERS"] ?? "jev")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  publicDailyBudgetUsd: Number(process.env["DOGFIGHT_PUBLIC_DAILY_USD"] ?? 5),
  publicDailyDecisions: Number(process.env["DOGFIGHT_PUBLIC_DAILY_DECISIONS"] ?? 40_000),
  publicBurstPerSecond: Number(process.env["DOGFIGHT_PUBLIC_BURST"] ?? 12),
  allowSeries: process.env["DOGFIGHT_ALLOW_SERIES"] !== "false",
  allowCallerKeys: process.env["DOGFIGHT_ALLOW_CALLER_KEYS"] !== "false",

  staticDir: process.env["DOGFIGHT_STATIC_DIR"] ?? "dist",
  maxSeriesRounds: Number(process.env["DOGFIGHT_MAX_ROUNDS"] ?? 10),

  anthropicApiKey: process.env["ANTHROPIC_API_KEY"],
  anthropicModel: process.env["ANTHROPIC_MODEL"] ?? "claude-opus-5",
  anthropicEffort: (process.env["ANTHROPIC_EFFORT"] ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",

  openaiApiKey: process.env["OPENAI_API_KEY"],
  openaiBaseUrl: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
  openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-4.1-mini",

  typesafeApiKey: process.env["TYPESAFE_API_KEY"],
  typesafeModel: process.env["TYPESAFE_MODEL"] ?? "jev-latest",
  typesafeUrl: process.env["TYPESAFE_URL"] ?? "https://api.typesafe.ai/v1/systemone",

  supabaseUrl: process.env["SUPABASE_URL"],
  supabaseServiceRoleKey: process.env["SUPABASE_SERVICE_ROLE_KEY"],
  supabaseAnonKey: process.env["SUPABASE_ANON_KEY"],

  liveMatchMinimumDecisions: Number(process.env["DOGFIGHT_LIVE_MIN_DECISIONS"] ?? 8),
  liveMatchesPerDay: Number(process.env["DOGFIGHT_LIVE_MATCHES_PER_DAY"] ?? 60),

  decisionTimeoutMs: Number(process.env["DECISION_TIMEOUT_MS"] ?? 4_000),
  decisionIntervalS: Number(process.env["DECISION_INTERVAL_S"] ?? 1),
  inferenceBudgetUsd: Number(process.env["INFERENCE_BUDGET_USD"] ?? 2),
} as const;

export function requireKey(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set; this provider is unavailable`);
  return value;
}
