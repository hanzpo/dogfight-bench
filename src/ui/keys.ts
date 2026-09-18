
export type KeyScope = "session" | "local";

export const KEYED_PROVIDERS = ["anthropic", "openai"] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export interface ProviderKey {
  key: string;
  scope: KeyScope;
  model?: string;
}

const PREFIX = "dogfight.provider-key.";

function store(scope: KeyScope): Storage | undefined {
  try {
    return scope === "local" ? localStorage : sessionStorage;
  } catch {
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

export function keyHeaders(provider: string): Record<string, string> {
  const stored = loadKey(provider);
  if (!stored) return {};
  return {
    "x-provider-key": stored.key,
    ...(stored.model ? { "x-provider-model": stored.model } : {}),
  };
}

export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}${"•".repeat(8)}${key.slice(-4)}`;
}
