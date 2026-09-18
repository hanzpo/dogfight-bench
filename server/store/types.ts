import type { AgentInfo } from "../../src/agents/agent";
import type { MatchSummary } from "../../src/sim/simulation";

export type CompetitorKind = "human" | "model" | "scripted";

export interface Competitor {
  id: string;
  kind: CompetitorKind;
  displayName: string;
  provider: string;
  model: string;
  policyVersion: string;
  schema: "raw" | "tactical";
  userId?: string | undefined;
  provisional?: boolean | undefined;
}

export function competitorIdFor(info: AgentInfo): string {
  return `${info.provider}:${info.model}:${info.policyVersion}`;
}

export function competitorFor(info: AgentInfo): Competitor {
  return {
    id: competitorIdFor(info),
    kind: info.provider === "scripted" ? "scripted" : "model",
    displayName: info.name,
    provider: info.provider,
    model: info.model,
    policyVersion: info.policyVersion,
    schema: info.schema,
  };
}

export function humanCompetitor(userId: string, displayName: string, provisional: boolean): Competitor {
  return {
    id: `human:${userId}`,
    kind: "human",
    displayName,
    provider: "human",
    model: "human",
    policyVersion: "1",
    schema: "raw",
    userId,
    provisional,
  };
}

export interface RecordedMatch {
  id: string;
  summary: MatchSummary;
  competitors: Record<string, Competitor>;
  origin: "headless" | "live";
  verified: boolean;
  replayJson?: string | undefined;
  submittedBy?: string | undefined;
}

export interface LeaderboardRow {
  competitorId: string;
  kind: CompetitorKind;
  name: string;
  provider: string;
  model: string;
  policyVersion: string;
  schema: "raw" | "tactical";
  provisional: boolean;
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

/** Everything a leaderboard row is counted from, before the ratios are taken. */
export interface CompetitorTotals {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  survivals: number;
  hitsScored: number;
  hitsTaken: number;
  roundsFired: number;
  timeOnTargetS: number;
  decisions: number;
  failures: number;
  avgLatencyMs: number;
  costUsd: number;
}

type Identity = Pick<
  LeaderboardRow,
  "competitorId" | "kind" | "name" | "provider" | "model" | "policyVersion" | "schema" | "provisional" | "rating"
>;

/**
 * Turns one competitor's totals into a leaderboard row.
 *
 * Both stores count differently -- one in SQL, one over fetched rows -- but
 * every rate is the same ratio of the same totals, so they agree here or the
 * two deployments quietly disagree about what accuracy means.
 */
export function leaderboardRow(identity: Identity, totals: CompetitorTotals): LeaderboardRow {
  const { matches, decisions, failures, roundsFired, costUsd } = totals;
  return {
    ...identity,
    matches,
    wins: totals.wins,
    losses: totals.losses,
    draws: totals.draws,
    winRate: matches ? totals.wins / matches : 0,
    hitsScored: totals.hitsScored,
    hitsTaken: totals.hitsTaken,
    roundsFired,
    accuracy: roundsFired ? totals.hitsScored / roundsFired : 0,
    timeOnTargetS: totals.timeOnTargetS,
    survivalRate: matches ? totals.survivals / matches : 0,
    decisions,
    failureRate: decisions + failures > 0 ? failures / (decisions + failures) : 0,
    avgLatencyMs: totals.avgLatencyMs,
    costUsd,
    costPerMatchUsd: matches ? costUsd / matches : 0,
  };
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

export interface LiveTicket {
  id: string;
  userId?: string | undefined;
  opponentKind: string;
  decisionsServed: number;
  costUsd: number;
  settled: boolean;
  createdAt: string;
}

export interface ResultsStore {
  recordMatch(match: RecordedMatch): Promise<void>;
  leaderboard(kinds: CompetitorKind[], options?: { includeProvisional?: boolean }): Promise<LeaderboardRow[]>;
  listMatches(options: { limit: number; userId?: string | undefined }): Promise<MatchRow[]>;
  getMatch(id: string): Promise<Record<string, unknown> | undefined>;
  getReplay(id: string): Promise<string | undefined>;

  publicUsageToday(provider: string): Promise<{ decisions: number; costUsd: number }>;
  recordPublicUsage(provider: string, costUsd: number): Promise<void>;

  openLiveMatch(ticket: { id: string; userId?: string | undefined; opponentKind: string }): Promise<void>;
  noteLiveDecision(id: string, costUsd: number): Promise<void>;
  settleLiveMatch(id: string): Promise<LiveTicket | undefined>;

  close(): void;
}

export type MatchResult = "win" | "loss" | "draw";

export function matchResult(winnerId: string | undefined, aircraftId: string): MatchResult {
  if (!winnerId) return "draw";
  return winnerId === aircraftId ? "win" : "loss";
}

/** The first competitor's Elo score for a match: 1 a win, 0 a loss, 0.5 a draw. */
export function eloScore(winnerId: string | undefined, first: string, second: string): number {
  if (winnerId === first) return 1;
  if (winnerId === second) return 0;
  return 0.5;
}
