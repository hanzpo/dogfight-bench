import type { AgentInfo } from "../../src/agents/agent";
import type { MatchSummary } from "../../src/sim/simulation";

/**
 * Where results live.
 *
 * Two implementations, because they answer different needs. SQLite is a file
 * on disk with no service behind it: it is what the tests, the command line
 * benchmark and a laptop use, and it works with no network at all. Supabase is
 * what a deployment uses, because a crowdsourced leaderboard needs accounts,
 * somewhere to put replays, and a rating that several processes can update
 * without racing each other.
 *
 * The interface is asynchronous throughout even though SQLite is not, because
 * the alternative is two shapes of every call site.
 */

export type CompetitorKind = "human" | "model" | "scripted";

/**
 * Anything that can hold a rating.
 *
 * A model's identity is provider, model and policy version together. The
 * policy version belongs in it: changing the prompt changes the player, and
 * folding the new one's results into the old one's rating would quietly make
 * the number mean nothing. A person's identity is their account.
 */
export interface Competitor {
  id: string;
  kind: CompetitorKind;
  displayName: string;
  provider: string;
  model: string;
  policyVersion: string;
  /** Set for humans, so an account can find its own matches. */
  userId?: string | undefined;
  /**
   * True for a guest who has not attached an account.
   *
   * They are rated, and their wins still cost their opponent, because refusing
   * that would let a model farm guests for free. They are left off the visible
   * board, because otherwise one person with a fresh guest session each time is
   * the whole leaderboard.
   */
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
    userId,
    provisional,
  };
}

export interface RecordedMatch {
  id: string;
  summary: MatchSummary;
  /** Who flew each aircraft, keyed by aircraft id. */
  competitors: Record<string, Competitor>;
  /**
   * `headless` matches were run by the server and reproduce exactly from their
   * decision log. `live` matches were flown in a browser and do not: a live
   * decision is applied whenever the network returns it.
   */
  origin: "headless" | "live";
  /** True when the server served every decision, so the result is not invented. */
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

/** A live match the server issued, and what it has actually served for it. */
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
  /**
   * Ranked competitors of the requested kinds.
   *
   * Provisional guests are excluded unless asked for: their wins still cost
   * their opponent, because refusing that would let a model farm guests for
   * free, but listing them means one person with a fresh guest session each
   * time is the whole board.
   */
  leaderboard(kinds: CompetitorKind[], options?: { includeProvisional?: boolean }): Promise<LeaderboardRow[]>;
  listMatches(options: { limit: number; userId?: string | undefined }): Promise<MatchRow[]>;
  getMatch(id: string): Promise<Record<string, unknown> | undefined>;
  getReplay(id: string): Promise<string | undefined>;

  publicUsageToday(provider: string): Promise<{ decisions: number; costUsd: number }>;
  recordPublicUsage(provider: string, costUsd: number): Promise<void>;

  openLiveMatch(ticket: { id: string; userId?: string | undefined; opponentKind: string }): Promise<void>;
  noteLiveDecision(id: string, costUsd: number): Promise<void>;
  /** Reads a ticket and marks it settled, so a result can only be reported once. */
  settleLiveMatch(id: string): Promise<LiveTicket | undefined>;

  close(): void;
}
