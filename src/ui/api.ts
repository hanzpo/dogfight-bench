import type { ReplayFile } from "../sim/replay";

/**
 * Client for the benchmark server.
 *
 * Every call goes through the server, which is what keeps provider credentials
 * out of the browser. If the server is not running, the pages say so instead of
 * showing an empty leaderboard as though nobody had ever flown.
 */

export interface LeaderboardEntry {
  competitorId: string;
  kind: "human" | "model" | "scripted";
  provisional: boolean;
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
  winner: string | null;
  reason: string | null;
  origin: string;
  verified: boolean;
  participants: Array<{
    aircraftId: string;
    competitorId: string;
    name: string;
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

export interface AccountSummary {
  id: string;
  displayName: string;
  anonymous: boolean;
}

/** A live match the server has agreed to count, if it is reported back. */
export interface LiveTicket {
  matchId: string;
  /** False when nobody is signed in, so the result will not be recorded. */
  ranked: boolean;
  /** True when results go to a shared leaderboard rather than a local file. */
  shared: boolean;
}

export class ServerUnavailableError extends Error {
  constructor() {
    super("The benchmark server is not reachable. Start it with `npm run server`.");
    this.name = "ServerUnavailableError";
  }
}

async function get<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { headers });
  } catch {
    throw new ServerUnavailableError();
  }
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServerUnavailableError();
  }
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(parsed.error ?? `${path} returned HTTP ${response.status}`);
  return parsed;
}

export const api = {
  leaderboard: () => get<{ leaderboard: LeaderboardEntry[] }>("/api/leaderboard").then((body) => body.leaderboard),
  matches: () => get<{ matches: MatchRow[] }>("/api/matches").then((body) => body.matches),
  agents: () => get<{ agents: AgentRow[] }>("/api/agents").then((body) => body.agents),
  roster: () => get<{ agents: AgentRow[]; freeBudget: FreeBudget[] }>("/api/agents"),
  replay: (id: string) => get<ReplayFile>(`/api/matches/${id}/replay`),

  leaderboardOf: (kinds: string[]) =>
    get<{ leaderboard: LeaderboardEntry[] }>(`/api/leaderboard?kinds=${encodeURIComponent(kinds.join(","))}`).then(
      (body) => body.leaderboard,
    ),

  me: (headers: Record<string, string>) =>
    get<{ account: AccountSummary | null; sharedLeaderboard: boolean }>("/api/me", headers),

  myMatches: (headers: Record<string, string>) =>
    get<{ matches: MatchRow[] }>("/api/me/matches", headers).then((body) => body.matches),

  startLiveMatch: (opponent: string, headers: Record<string, string>) =>
    post<LiveTicket>("/api/live/start", { opponent }, headers),

  reportLiveMatch: (
    matchId: string,
    payload: { summary: unknown; replay?: string; humanAircraftId: string },
    headers: Record<string, string>,
  ) => post<{ counted: boolean; provisional: boolean }>(`/api/live/${matchId}/result`, payload, headers),
};
