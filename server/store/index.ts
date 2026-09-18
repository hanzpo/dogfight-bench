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
  /**
   * There is no local file on a Worker.
   *
   * `node:sqlite` imports there and then refuses to construct, so without this
   * the failure is an "Illegal constructor" thrown while the module is still
   * being evaluated -- before any request handler exists to explain it.
   */
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    throw new Error(
      "A Worker has no filesystem and cannot use SQLite. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return new SqliteStore();
}

/** True when results are going somewhere other people can see. */
export function storeIsShared(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}
