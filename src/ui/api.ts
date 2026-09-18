import type { ReplayFile } from "../sim/replay";

/**
 * Client for the benchmark server.
 *
 * Every call goes through the server, which is what keeps provider credentials
 * out of the browser. If the server is not running, the pages say so instead of
 * showing an empty leaderboard as though nobody had ever flown.
 */

export interface LeaderboardEntry {
  agentId: string;
  name: string;
  provider: string;
  model: string;
  policyVersion: string;
  rating: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  hitsScored: number;
  hitsTaken: number;
  roundsFired: number;
  accuracy: number;
  timeOnTargetS: number;
  survivalRate: number;
  decisions: number;
  failureRate: number;
  avgLatencyMs: number;
  costUsd: number;
  costPerMatchUsd: number;
}

export interface MatchRow {
  id: string;
  scenarioId: string;
  seed: number;
  createdAt: string;
  durationS: number;
  winnerAgent: string | null;
  reason: string | null;
  participants: Array<{
    aircraftId: string;
    agentId: string;
    result: string;
    hitsScored: number;
    costUsd: number;
  }>;
}

export interface AgentRow {
  kind: string;
  /** This deployment holds a credential for it. */
  available: boolean;
  /** Anyone may fly it without supplying a key, up to the shared daily cap. */
  free: boolean;
  /** It can be flown by supplying your own key. */
  acceptsCallerKey: boolean;
  name: string;
  provider: string;
  model: string;
  schema: string;
  pricing: { inputPerMTok: number; outputPerMTok: number } | null;
}

/** What is left of the shared daily allowance for the free providers. */
export interface FreeBudget {
  provider: string;
  decisions: number;
  costUsd: number;
  dailyBudgetUsd: number;
  dailyDecisions: number;
  exhausted: boolean;
}

export class ServerUnavailableError extends Error {
  constructor() {
    super("The benchmark server is not reachable. Start it with `npm run server`.");
    this.name = "ServerUnavailableError";
  }
}

async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new ServerUnavailableError();
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

export const api = {
  leaderboard: () => get<{ leaderboard: LeaderboardEntry[] }>("/api/leaderboard").then((body) => body.leaderboard),
  matches: () => get<{ matches: MatchRow[] }>("/api/matches").then((body) => body.matches),
  agents: () => get<{ agents: AgentRow[] }>("/api/agents").then((body) => body.agents),
  roster: () => get<{ agents: AgentRow[]; freeBudget: FreeBudget[] }>("/api/agents"),
  replay: (id: string) => get<ReplayFile>(`/api/matches/${id}/replay`),
};
