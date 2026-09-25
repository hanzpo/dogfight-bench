import type { ReplayFile } from "../sim/replay";

export interface LeaderboardEntry {
  competitorId: string;
  kind: "human" | "model" | "scripted";
  provisional: boolean;
  name: string;
  provider: string;
  model: string;
  policyVersion: string;
  schema: "raw" | "tactical";
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
  available: boolean;
  free: boolean;
  acceptsCallerKey: boolean;
  name: string;
  provider: string;
  model: string;
  schema: string;
  pricing: { inputPerMTok: number; outputPerMTok: number } | null;
}

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

export interface LiveTicket {
  matchId: string;
  ranked: boolean;
  shared: boolean;
}

export class ServerUnavailableError extends Error {
  constructor() {
    super(
      import.meta.env.DEV
        ? "The API server isn't running. Start everything with `npm run dev:all`, or just it with `npm run dev:server`."
        : "The server is not reachable just now.",
    );
    this.name = "ServerUnavailableError";
  }
}

/**
 * One request path, so a failure says the same thing whichever verb it was.
 *
 * `get` used to throw the status code alone and drop the body, so the reason
 * the server had carefully written -- which provider needs a key, what the
 * deployment is missing -- never reached the screen.
 */
async function request<T>(path: string, init: RequestInit, headers: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), ...headers } });
  } catch {
    throw new ServerUnavailableError();
  }
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  // In development a proxy with nothing behind it answers 500 with no body; the server itself always says why.
  if (import.meta.env.DEV && response.status >= 500 && !parsed.error) throw new ServerUnavailableError();
  if (!response.ok) throw new Error(parsed.error ?? `${path} returned HTTP ${response.status}`);
  return parsed;
}

const get = <T>(path: string, headers: Record<string, string> = {}): Promise<T> => request<T>(path, {}, headers);

const post = <T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> =>
  request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, headers);

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
