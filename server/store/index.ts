import { env } from "../env";
import { SqliteStore } from "./sqlite";
import { SupabaseStore } from "./supabase";
import type { ResultsStore } from "./types";

export * from "./types";
export { SqliteStore } from "./sqlite";

export function createStore(): ResultsStore {
  if (env.supabaseUrl && env.supabaseServiceRoleKey) {
    return new SupabaseStore(env.supabaseUrl, env.supabaseServiceRoleKey);
  }
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
    throw new Error(
      "A Worker has no filesystem and cannot use SQLite. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return new SqliteStore();
}

export function storeIsShared(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}
