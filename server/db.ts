import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env";
import type { AgentInfo } from "../src/agents/agent";
import type { MatchSummary } from "../src/sim/simulation";

/**
 * Match storage.
 *
 * Node's built-in SQLite keeps the benchmark a single `npm install` with no
 * native build step, and a file on disk means a leaderboard can be inspected,
 * copied and diffed without a service behind it.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  schema        TEXT NOT NULL,
  rating        REAL NOT NULL DEFAULT 1500,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL,
  seed         INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  duration_s   REAL NOT NULL,
  winner_agent TEXT,
  reason       TEXT,
  summary_json TEXT NOT NULL,
  replay_json  TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  match_id      TEXT NOT NULL,
  aircraft_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  team          TEXT NOT NULL,
  result        TEXT NOT NULL,
  survived      INTEGER NOT NULL,
  health        REAL NOT NULL,
  hits_scored   INTEGER NOT NULL,
  hits_taken    INTEGER NOT NULL,
  rounds_fired  INTEGER NOT NULL,
  time_on_target_s REAL NOT NULL,
  time_in_zone_s   REAL NOT NULL,
  decisions     INTEGER NOT NULL,
  failures      INTEGER NOT NULL,
  timeouts      INTEGER NOT NULL,
  avg_latency_ms REAL NOT NULL,
  cost_usd      REAL NOT NULL,
  PRIMARY KEY (match_id, aircraft_id)
);

CREATE INDEX IF NOT EXISTS participants_agent ON participants(agent_id);
CREATE INDEX IF NOT EXISTS matches_created ON matches(created_at DESC);
`;

export interface LeaderboardRow {
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

export function agentKey(info: AgentInfo): string {
  return `${info.provider}:${info.model}:${info.policyVersion}`;
}

export class MatchStore {
  private readonly db: DatabaseSync;

  constructor(path = env.databasePath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  upsertAgent(info: AgentInfo): string {
    const id = agentKey(info);
    this.db
      .prepare(
        `INSERT INTO agents (id, name, provider, model, policy_version, schema, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      )
      .run(id, info.name, info.provider, info.model, info.policyVersion, info.schema, new Date().toISOString());
    return id;
  }

  /**
   * Records a finished match and updates ratings.
   *
   * Rating is plain Elo. It is not a strong statistical claim, but it handles
   * the thing a raw win rate cannot: an agent that only ever fought the weakest
   * opponent should not outrank one that beat a strong field.
   */
  recordMatch(options: {
    id: string;
    summary: MatchSummary;
    agents: Record<string, AgentInfo>;
    replayJson?: string;
  }): void {
    const { id, summary, agents, replayJson } = options;
    const agentIds = Object.fromEntries(
      Object.entries(agents).map(([aircraftId, info]) => [aircraftId, this.upsertAgent(info)]),
    );
    const winnerAgent = summary.winnerId ? agentIds[summary.winnerId] : undefined;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO matches
         (id, scenario_id, seed, created_at, duration_s, winner_agent, reason, summary_json, replay_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        summary.scenarioId,
        summary.seed,
        new Date().toISOString(),
        summary.durationS,
        winnerAgent ?? null,
        summary.reason ?? null,
        JSON.stringify(summary),
        replayJson ?? null,
      );

    for (const aircraft of summary.aircraft) {
      const agentId = agentIds[aircraft.id];
      if (!agentId) continue;
      const stats = summary.agents[aircraft.id];
      const result = summary.winnerId
        ? summary.winnerId === aircraft.id
          ? "win"
          : "loss"
        : "draw";
      this.db
        .prepare(
          `INSERT OR REPLACE INTO participants
           (match_id, aircraft_id, agent_id, team, result, survived, health, hits_scored, hits_taken,
            rounds_fired, time_on_target_s, time_in_zone_s, decisions, failures, timeouts, avg_latency_ms, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          aircraft.id,
          agentId,
          aircraft.team,
          result,
          aircraft.alive ? 1 : 0,
          aircraft.health,
          aircraft.hitsScored,
          aircraft.hitsTaken,
          aircraft.roundsFired,
          aircraft.timeOnTargetS,
          aircraft.timeInControlZoneS,
          stats?.decisions ?? 0,
          stats?.failures ?? 0,
          stats?.timeouts ?? 0,
          stats?.averageLatencyMs ?? 0,
          stats?.costUsd ?? 0,
        );
    }

    this.updateRatings(summary, agentIds);
  }

  private updateRatings(summary: MatchSummary, agentIds: Record<string, string>): void {
    const [first, second] = summary.aircraft;
    if (!first || !second) return;
    const a = agentIds[first.id];
    const b = agentIds[second.id];
    if (!a || !b || a === b) return;

    const ratingOf = (id: string) =>
      (this.db.prepare("SELECT rating FROM agents WHERE id = ?").get(id) as { rating?: number } | undefined)
        ?.rating ?? 1500;
    const ratingA = ratingOf(a);
    const ratingB = ratingOf(b);
    const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
    const scoreA = summary.winnerId === first.id ? 1 : summary.winnerId === second.id ? 0 : 0.5;
    const k = 24;

    const update = this.db.prepare("UPDATE agents SET rating = ? WHERE id = ?");
    update.run(ratingA + k * (scoreA - expectedA), a);
    update.run(ratingB + k * (1 - scoreA - (1 - expectedA)), b);
  }

  leaderboard(): LeaderboardRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS agentId, a.name, a.provider, a.model, a.policy_version AS policyVersion, a.rating,
                COUNT(p.match_id) AS matches,
                SUM(CASE WHEN p.result = 'win' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN p.result = 'loss' THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN p.result = 'draw' THEN 1 ELSE 0 END) AS draws,
                SUM(p.survived) AS survivals,
                SUM(p.hits_scored) AS hitsScored,
                SUM(p.hits_taken) AS hitsTaken,
                SUM(p.rounds_fired) AS roundsFired,
                SUM(p.time_on_target_s) AS timeOnTargetS,
                SUM(p.decisions) AS decisions,
                SUM(p.failures) AS failures,
                AVG(p.avg_latency_ms) AS avgLatencyMs,
                SUM(p.cost_usd) AS costUsd
         FROM agents a
         JOIN participants p ON p.agent_id = a.id
         GROUP BY a.id
         ORDER BY a.rating DESC`,
      )
      .all() as Array<Record<string, number | string | null>>;

    return rows.map((row) => {
      const matches = Number(row["matches"] ?? 0);
      const rounds = Number(row["roundsFired"] ?? 0);
      const decisions = Number(row["decisions"] ?? 0);
      const costUsd = Number(row["costUsd"] ?? 0);
      return {
        agentId: String(row["agentId"]),
        name: String(row["name"]),
        provider: String(row["provider"]),
        model: String(row["model"]),
        policyVersion: String(row["policyVersion"]),
        rating: Number(row["rating"] ?? 1500),
        matches,
        wins: Number(row["wins"] ?? 0),
        losses: Number(row["losses"] ?? 0),
        draws: Number(row["draws"] ?? 0),
        winRate: matches ? Number(row["wins"] ?? 0) / matches : 0,
        hitsScored: Number(row["hitsScored"] ?? 0),
        hitsTaken: Number(row["hitsTaken"] ?? 0),
        roundsFired: rounds,
        accuracy: rounds ? Number(row["hitsScored"] ?? 0) / rounds : 0,
        timeOnTargetS: Number(row["timeOnTargetS"] ?? 0),
        survivalRate: matches ? Number(row["survivals"] ?? 0) / matches : 0,
        decisions,
        failureRate: decisions + Number(row["failures"] ?? 0) > 0
          ? Number(row["failures"] ?? 0) / (decisions + Number(row["failures"] ?? 0))
          : 0,
        avgLatencyMs: Number(row["avgLatencyMs"] ?? 0),
        costUsd,
        costPerMatchUsd: matches ? costUsd / matches : 0,
      };
    });
  }

  listMatches(limit = 50): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT m.id, m.scenario_id AS scenarioId, m.seed, m.created_at AS createdAt, m.duration_s AS durationS,
                m.winner_agent AS winnerAgent, m.reason,
                (SELECT json_group_array(json_object('aircraftId', p.aircraft_id, 'agentId', p.agent_id,
                                                     'result', p.result, 'hitsScored', p.hits_scored,
                                                     'costUsd', p.cost_usd))
                 FROM participants p WHERE p.match_id = m.id) AS participants
         FROM matches m ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row: unknown) => {
        const record = row as Record<string, unknown>;
        return { ...record, participants: JSON.parse(String(record["participants"] ?? "[]")) as unknown };
      });
  }

  getMatch(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return { ...row, summary: JSON.parse(String(row["summary_json"])) as unknown, summary_json: undefined };
  }

  getReplay(id: string): string | undefined {
    const row = this.db.prepare("SELECT replay_json FROM matches WHERE id = ?").get(id) as
      | { replay_json?: string | null }
      | undefined;
    return row?.replay_json ?? undefined;
  }
}
