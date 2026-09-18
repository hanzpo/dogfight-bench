import { env } from "./env";

export interface Account {
  id: string;
  displayName: string;
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

export function forgetAccount(authorization: string | undefined): void {
  const token = bearer(authorization);
  if (token) cache.delete(token);
}
