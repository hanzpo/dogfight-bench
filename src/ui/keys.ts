/**
 * Provider keys the person supplies themselves.
 *
 * The benchmark's own credentials live on the server and never reach the
 * browser. This is the other direction: a key that belongs to the person using
 * the page, held here so it can be attached to their own requests.
 *
 * Two rules make that safe enough to offer:
 *
 * The key is sent to this application's own `/api/decide` and nowhere else. The
 * server uses it for one upstream call and drops it -- it is never written to
 * the database, never logged, and never becomes the server's credential.
 *
 * Where it is kept is the person's choice, and the honest default is the one
 * that forgets. `session` lives in `sessionStorage`, so closing the tab takes
 * it with it. `local` survives restarts, which is convenient and means any
 * script that ever manages to run on this origin can read it; the UI says so
 * rather than quietly making the convenient choice on someone's behalf.
 */

export type KeyScope = "session" | "local";

/** Providers that can be driven with a key supplied here. */
export const KEYED_PROVIDERS = ["anthropic", "openai"] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export interface ProviderKey {
  key: string;
  scope: KeyScope;
  /** Optional model override, so a key is useful without a server change. */
  model?: string;
}

const PREFIX = "dogfight.provider-key.";

function store(scope: KeyScope): Storage | undefined {
  try {
    return scope === "local" ? localStorage : sessionStorage;
  } catch {
    // Blocked storage is not an error; it just means nothing is remembered.
    return undefined;
  }
}

export function loadKey(provider: string): ProviderKey | undefined {
  for (const scope of ["session", "local"] as const) {
    try {
      const raw = store(scope)?.getItem(PREFIX + provider);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { key?: unknown; model?: unknown };
      if (typeof parsed.key !== "string" || !parsed.key) continue;
      return {
        key: parsed.key,
        scope,
        ...(typeof parsed.model === "string" && parsed.model ? { model: parsed.model } : {}),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function saveKey(provider: string, key: string, scope: KeyScope, model?: string): void {
  clearKey(provider);
  if (!key.trim()) return;
  try {
    store(scope)?.setItem(
      PREFIX + provider,
      JSON.stringify({ key: key.trim(), ...(model?.trim() ? { model: model.trim() } : {}) }),
    );
  } catch {
    // Nothing to do: the key simply will not be remembered.
  }
}

export function clearKey(provider: string): void {
  for (const scope of ["session", "local"] as const) {
    try {
      store(scope)?.removeItem(PREFIX + provider);
    } catch {
      continue;
    }
  }
}

/** Headers that carry the key on a decision request, or nothing at all. */
export function keyHeaders(provider: string): Record<string, string> {
  const stored = loadKey(provider);
  if (!stored) return {};
  return {
    "x-provider-key": stored.key,
    ...(stored.model ? { "x-provider-model": stored.model } : {}),
  };
}

/** Shows enough of a key to recognise it, and not enough to use it. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}
