import { env } from "../env";
import { SqliteStore } from "./sqlite";
import { SupabaseStore } from "./supabase";
import type { ResultsStore } from "./types";

export * from "./types";
export { SqliteStore } from "./sqlite";

/**
 * Chooses where results go.
 *
 * Supabase when it is configured, a local file otherwise. The fallback is not a
 * degraded mode -- it is what the tests, the command line benchmark and a
 * laptop with no network use, and it has to keep working or the benchmark stops
 * being runnable by anyone who is not this deployment.
 */
export function createStore(): ResultsStore {
  if (env.supabaseUrl && env.supabaseServiceRoleKey) {
    return new SupabaseStore(env.supabaseUrl, env.supabaseServiceRoleKey);
  }
  return new SqliteStore();
}

/** True when results are going somewhere other people can see. */
export function storeIsShared(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}
