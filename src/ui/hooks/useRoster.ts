import { useEffect, useState } from "react";
import { api, type AgentRow, type FreeBudget } from "../api";

/**
 * Who this deployment can field, and what the free allowance has left.
 *
 * Fetched rather than hard-coded, because which providers exist and which are
 * free is a property of the deployment: the same build runs locally with every
 * key present and in public with one free model and the rest needing your own.
 */
export interface Roster {
  agents: AgentRow[];
  freeBudget: FreeBudget[];
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}

export function useRoster(): Roster {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [freeBudget, setFreeBudget] = useState<FreeBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .roster()
      .then((body) => {
        if (cancelled) return;
        setAgents(body.agents);
        setFreeBudget(body.freeBudget ?? []);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A missing server is not an error worth shouting about here: the
        // scripted opponents still fly, so the page stays useful.
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { agents, freeBudget, loading, error, refresh: () => setNonce((value) => value + 1) };
}
