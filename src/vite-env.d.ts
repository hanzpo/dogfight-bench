/// <reference types="vite/client" />

/**
 * Configuration the browser is allowed to know.
 *
 * Only values that are public by design belong here: the Supabase project URL
 * and its publishable key, which grant nothing beyond acting as whoever is
 * signed in. Provider credentials live on the server and must never appear in
 * a `VITE_` variable, because everything with that prefix is compiled into the
 * bundle and served to everyone.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
