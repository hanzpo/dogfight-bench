import { env } from "./env";

/**
 * Who is calling.
 *
 * The browser signs in against Supabase directly and sends the resulting access
 * token here. This verifies it by asking Supabase who the token belongs to,
 * rather than by decoding it locally: local verification needs the project's
 * signing secret, which is one more credential to hold and to rotate, and gets
 * subtly wrong when a project moves to asymmetric keys.
 *
 * The round trip is cheap because it is not on the hot path -- a match is
 * authenticated when it starts and when its result is reported, not on every
 * decision -- and answers are cached briefly anyway.
 */

export interface Account {
  id: string;
  displayName: string;
  /** True for a guest session: rated, but kept off the visible board. */
  anonymous: boolean;
}

interface CacheEntry {
  account: Account;
  expires: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function bearer(header: string | undefined): string | undefined {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  return token && token.length > 20 ? token : undefined;
}

/**
 * A display name that is safe to put on a public leaderboard.
 *
 * Preference order is what the person chose, then their provider's name, then
 * the local part of their email -- never the address itself, which they did not
 * agree to publish by signing in.
 */
function displayNameFor(user: Record<string, unknown>): string {
  const metadata = (user["user_metadata"] ?? {}) as Record<string, unknown>;
  for (const key of ["display_name", "name", "full_name", "user_name", "preferred_username"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 40);
  }
  const email = user["email"];
  if (typeof email === "string" && email.includes("@")) return email.split("@")[0]!.slice(0, 40);
  return "Pilot";
}

export async function accountFor(authorization: string | undefined): Promise<Account | undefined> {
  const token = bearer(authorization);
  if (!token || !env.supabaseUrl || !env.supabaseAnonKey) return undefined;

  const cached = cache.get(token);
  if (cached && cached.expires > Date.now()) return cached.account;

  let response: Response;
  try {
    response = await fetch(`${env.supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: env.supabaseAnonKey },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  const user = (await response.json()) as Record<string, unknown>;
  const id = user["id"];
  if (typeof id !== "string") return undefined;

  const account: Account = {
    id,
    displayName: displayNameFor(user),
    anonymous: user["is_anonymous"] === true,
  };
  if (cache.size > 5_000) cache.clear();
  cache.set(token, { account, expires: Date.now() + CACHE_TTL_MS });
  return account;
}

/** Forgets a cached account, so signing out takes effect immediately. */
export function forgetAccount(authorization: string | undefined): void {
  const token = bearer(authorization);
  if (token) cache.delete(token);
}
