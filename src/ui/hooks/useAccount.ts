import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { authConfigured, displayNameOf, signOut, supabase } from "../auth";

export interface AccountState {
  user: User | undefined;
  displayName: string;
  isGuest: boolean;
  configured: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

export function useAccount(): AccountState {
  const [user, setUser] = useState<User>();
  const [loading, setLoading] = useState(authConfigured);

  useEffect(() => {
    const sdk = supabase();
    if (!sdk) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void sdk.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setUser(data.session?.user ?? undefined);
      setLoading(false);
    });
    const { data: subscription } = sdk.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? undefined);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const out = useCallback(async () => {
    await signOut();
    setUser(undefined);
  }, []);

  return {
    user,
    displayName: displayNameOf(user),
    isGuest: user?.is_anonymous === true,
    configured: authConfigured,
    loading,
    signOut: out,
  };
}
