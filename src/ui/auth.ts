import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";

/**
 * Signing in.
 *
 * The browser talks to Supabase directly for authentication and gets back an
 * access token, which it then sends to this application's own server. The
 * server verifies the token with Supabase rather than trusting it, so the
 * publishable key below grants nothing beyond acting as whoever signed in --
 * which is why it is safe to ship in the bundle, unlike every provider
 * credential, which is not here and never will be.
 *
 * Authentication is optional. Without it the simulator, the baselines and the
 * free model all work exactly as before; what an account adds is a result that
 * counts on the leaderboard and replays that are kept.
 */

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
    // Come back to the page they left, not to the site root.
    options: { redirectTo: `${location.origin}${location.pathname}` },
  });
  return error?.message;
}

/**
 * A guest session.
 *
 * Real enough to own replays and to hold a rating, so somebody can fly a ranked
 * match without handing over an identity first. Guests are marked provisional
 * and left off the visible board: one person with a fresh guest session each
 * time would otherwise be the entire leaderboard.
 */
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

/** Headers that identify the caller, or nothing when nobody is signed in. */
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
