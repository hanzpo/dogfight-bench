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
  /**
   * Providers anyone may use on this server's own credentials, with no key and
   * no token, subject to the daily cap below.
   *
   * Everything else requires the caller to bring their own key. The point is
   * that an open deployment can offer one model for free without offering its
   * whole inference budget to the internet.
   */
  publicProviders: (process.env["DOGFIGHT_PUBLIC_PROVIDERS"] ?? "jev")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  /** Dollars a day the free providers may spend across everybody, together. */
  publicDailyBudgetUsd: Number(process.env["DOGFIGHT_PUBLIC_DAILY_USD"] ?? 5),
  /** Decisions a day the free providers may serve, as a second backstop. */
  publicDailyDecisions: Number(process.env["DOGFIGHT_PUBLIC_DAILY_DECISIONS"] ?? 40_000),
  /**
   * Requests a second from one address before it is throttled.
   *
   * Not a quota -- the quota is the daily cap above, shared by everyone. This
   * exists so a runaway loop in one tab cannot drain the day's budget in a
   * minute before anybody else gets a turn.
   */
  publicBurstPerSecond: Number(process.env["DOGFIGHT_PUBLIC_BURST"] ?? 12),
  /** Set false to refuse caller-supplied provider keys entirely. */
  allowCallerKeys: process.env["DOGFIGHT_ALLOW_CALLER_KEYS"] !== "false",

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

  /**
   * Supabase, for a deployment with accounts and a shared leaderboard.
   *
   * The service role key bypasses row level security, so it belongs here with
   * the provider credentials and must never reach the browser. Without both of
   * these the server falls back to the local SQLite file, which is what the
   * tests and the command line benchmark use.
   */
  supabaseUrl: process.env["SUPABASE_URL"],
  supabaseServiceRoleKey: process.env["SUPABASE_SERVICE_ROLE_KEY"],
  /** Sent to the browser, and safe to: it only ever acts as the signed-in user. */
  supabaseAnonKey: process.env["SUPABASE_ANON_KEY"],

  /** Minimum decisions the server must have served before a live result counts. */
  liveMatchMinimumDecisions: Number(process.env["DOGFIGHT_LIVE_MIN_DECISIONS"] ?? 8),
  /** Live matches one account may report in a day. */
  liveMatchesPerDay: Number(process.env["DOGFIGHT_LIVE_MATCHES_PER_DAY"] ?? 60),

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
