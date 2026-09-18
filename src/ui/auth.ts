import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const authConfigured = Boolean(url && anonKey);

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient | undefined {
  if (!authConfigured) return undefined;
  client ??= createClient(url!, anonKey!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export type OAuthProvider = "google" | "github";

export async function signInWith(provider: OAuthProvider): Promise<string | undefined> {
  const sdk = supabase();
  if (!sdk) return "Accounts are not configured on this deployment.";
  const { error } = await sdk.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${location.origin}${location.pathname}` },
  });
  return error?.message;
}

export async function signInAsGuest(): Promise<string | undefined> {
  const sdk = supabase();
  if (!sdk) return "Accounts are not configured on this deployment.";
  const { error } = await sdk.auth.signInAnonymously();
  return error?.message;
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut();
}

export async function currentSession(): Promise<Session | null> {
  const sdk = supabase();
  if (!sdk) return null;
  const { data } = await sdk.auth.getSession();
  return data.session;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const session = await currentSession();
  return session ? { authorization: `Bearer ${session.access_token}` } : {};
}

export function displayNameOf(user: User | undefined): string {
  if (!user) return "Guest";
  if (user.is_anonymous) return "Guest";
  const metadata = user.user_metadata as Record<string, unknown>;
  for (const key of ["display_name", "name", "full_name", "user_name", "preferred_username"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return user.email?.split("@")[0] ?? "Pilot";
}
