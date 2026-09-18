import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../env";
import type {
  Competitor,
  CompetitorKind,
  LeaderboardRow,
  LiveTicket,
  MatchRow,
  RecordedMatch,
  ResultsStore,
} from "./types";

/**
 * Results in a file.
 *
 * Node's built-in SQLite keeps the benchmark a single `npm install` with no
 * native build step, and a file on disk means a leaderboard can be inspected,
 * copied and diffed without a service behind it. This is what the tests and
 * the command line benchmark use, and what a deployment falls back to when no
 * Supabase credentials are configured.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS competitors (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'model',
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  schema        TEXT NOT NULL DEFAULT 'tactical',
  user_id       TEXT,
  rating        REAL NOT NULL DEFAULT 1500,
  provisional   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  scenario_id  TEXT NOT NULL,
  seed         INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  duration_s   REAL NOT NULL,
  winner       TEXT,
  reason       TEXT,
  origin       TEXT NOT NULL DEFAULT 'headless',
  verified     INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  replay_json  TEXT,
  submitted_by TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  match_id      TEXT NOT NULL,
  aircraft_id   TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS public_usage (
  day       TEXT NOT NULL,
  provider  TEXT NOT NULL,
  decisions INTEGER NOT NULL DEFAULT 0,
  cost_usd  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS live_matches (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL,
  user_id          TEXT,
  opponent_kind    TEXT NOT NULL,
  decisions_served INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  settled          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS participants_competitor ON participants(competitor_id);
CREATE INDEX IF NOT EXISTS matches_created ON matches(created_at DESC);
`;

/** UTC calendar day, so the cap resets at a time nobody has to reason about. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export class SqliteStore implements ResultsStore {
  private readonly db: DatabaseSync;

  constructor(path = env.databasePath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrateFromAgents();
    this.db.exec(SCHEMA);
  }

  /**
   * Carries an older database forward.
   *
   * The first version of this schema called competitors "agents", because
   * everything that flew was a model. People can now hold a rating too, so the
   * table was renamed and gained a kind -- and somebody's existing benchmark
   * results should survive that rather than being silently replaced by an empty
   * leaderboard, or worse, a crash on startup.
   *
   * Driven by which columns exist rather than which tables do, so it is
   * idempotent and can finish a migration that was interrupted half way: a
   * failed start leaves some of the new tables already created, and a check for
   * "has the new table" would then skip the rest of the work forever.
   */
  private migrateFromAgents(): void {
    const names = (table: string): Set<string> => {
      try {
        return new Set(
          (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
        );
      } catch {
        return new Set();
      }
    };
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );

    const participants = names("participants");
    if (participants.has("agent_id") && !participants.has("competitor_id")) {
      this.db.exec("DROP INDEX IF EXISTS participants_agent");
      this.db.exec("ALTER TABLE participants RENAME COLUMN agent_id TO competitor_id");
    }

    const matches = names("matches");
    if (matches.has("winner_agent") && !matches.has("winner")) {
      this.db.exec("ALTER TABLE matches RENAME COLUMN winner_agent TO winner");
    }
    if (matches.size && !matches.has("origin")) {
      this.db.exec("ALTER TABLE matches ADD COLUMN origin TEXT NOT NULL DEFAULT 'headless'");
    }
    if (matches.size && !matches.has("verified")) {
      this.db.exec("ALTER TABLE matches ADD COLUMN verified INTEGER NOT NULL DEFAULT 1");
    }
    if (matches.size && !matches.has("submitted_by")) {
      this.db.exec("ALTER TABLE matches ADD COLUMN submitted_by TEXT");
    }

    const competitors = names("competitors");
    if (competitors.size && !competitors.has("schema")) {
      this.db.exec("ALTER TABLE competitors ADD COLUMN schema TEXT NOT NULL DEFAULT 'tactical'");
    }

    if (!tables.has("agents")) return;

    // Move the old rows across, then retire the table. Copied rather than
    // renamed because a previous interrupted start may already have created an
    // empty `competitors`.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS competitors (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'model', name TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, policy_version TEXT NOT NULL,
        user_id TEXT, rating REAL NOT NULL DEFAULT 1500,
        provisional INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      )`);
    this.db.exec(`
      INSERT OR IGNORE INTO competitors (id, kind, name, provider, model, policy_version, rating, created_at)
      SELECT id,
             CASE WHEN provider = 'scripted' THEN 'scripted' ELSE 'model' END,
             name, provider, model, policy_version, rating, created_at
        FROM agents`);
    this.db.exec("DROP TABLE agents");
  }

  close(): void {
    this.db.close();
  }

  private upsertCompetitor(competitor: Competitor): void {
    this.db
      .prepare(
        `INSERT INTO competitors (id, kind, name, provider, model, policy_version, schema, user_id, provisional, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, provisional = excluded.provisional`,
      )
      .run(
        competitor.id,
        competitor.kind,
        competitor.displayName,
        competitor.provider,
        competitor.model,
        competitor.policyVersion,
        competitor.schema,
        competitor.userId ?? null,
        competitor.provisional ? 1 : 0,
        new Date().toISOString(),
      );
  }

  /**
   * Records a finished match and updates ratings.
   *
   * Rating is plain Elo. It is not a strong statistical claim, but it handles
   * the thing a raw win rate cannot: a competitor that only ever fought the
   * weakest opponent should not outrank one that beat a strong field. It is
   * also what makes a crowdsourced board work -- two people beating the same
   * model must cost that model twice, which only happens because the model is
   * one row rather than one row per opponent.
   */
  async recordMatch(match: RecordedMatch): Promise<void> {
    const { id, summary, competitors, origin, verified, replayJson, submittedBy } = match;

    // Recording the same match twice must not move ratings twice.
    const existing = this.db.prepare("SELECT id FROM matches WHERE id = ?").get(id);
    if (existing) return;

    for (const competitor of Object.values(competitors)) this.upsertCompetitor(competitor);
    const winner = summary.winnerId ? competitors[summary.winnerId]?.id : undefined;

    this.db
      .prepare(
        `INSERT INTO matches
         (id, scenario_id, seed, created_at, duration_s, winner, reason, origin, verified, summary_json, replay_json, submitted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        summary.scenarioId,
        summary.seed,
        new Date().toISOString(),
        summary.durationS,
        winner ?? null,
        summary.reason ?? null,
        origin,
        verified ? 1 : 0,
        JSON.stringify(summary),
        replayJson ?? null,
        submittedBy ?? null,
      );

    for (const aircraft of summary.aircraft) {
      const competitor = competitors[aircraft.id];
      if (!competitor) continue;
      const stats = summary.agents[aircraft.id];
      const result = summary.winnerId ? (summary.winnerId === aircraft.id ? "win" : "loss") : "draw";
      this.db
        .prepare(
          `INSERT OR REPLACE INTO participants
           (match_id, aircraft_id, competitor_id, team, result, survived, health, hits_scored, hits_taken,
            rounds_fired, time_on_target_s, time_in_zone_s, decisions, failures, timeouts, avg_latency_ms, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          aircraft.id,
          competitor.id,
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

    this.updateRatings(summary, competitors);
  }

  private updateRatings(
    summary: RecordedMatch["summary"],
    competitors: Record<string, Competitor>,
  ): void {
    const [first, second] = summary.aircraft;
    if (!first || !second) return;
    const a = competitors[first.id]?.id;
    const b = competitors[second.id]?.id;
    if (!a || !b || a === b) return;

    const ratingOf = (competitorId: string) =>
      (this.db.prepare("SELECT rating FROM competitors WHERE id = ?").get(competitorId) as
        | { rating?: number }
        | undefined)?.rating ?? 1500;
    const ratingA = ratingOf(a);
    const ratingB = ratingOf(b);
    const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
    const scoreA = summary.winnerId === first.id ? 1 : summary.winnerId === second.id ? 0 : 0.5;
    const k = 24;

    const update = this.db.prepare("UPDATE competitors SET rating = ? WHERE id = ?");
    update.run(ratingA + k * (scoreA - expectedA), a);
    update.run(ratingB + k * (1 - scoreA - (1 - expectedA)), b);
  }

  async leaderboard(
    kinds: CompetitorKind[],
    options: { includeProvisional?: boolean } = {},
  ): Promise<LeaderboardRow[]> {
    const wanted = kinds.length ? kinds : ["model", "scripted"];
    const placeholders = wanted.map(() => "?").join(", ");
    const provisionalFilter = options.includeProvisional ? "" : "AND c.provisional = 0";
    const rows = this.db
      .prepare(
        `SELECT c.id AS competitorId, c.kind, c.name, c.provider, c.model,
                c.policy_version AS policyVersion, c.schema, c.rating, c.provisional,
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
         FROM competitors c
         JOIN participants p ON p.competitor_id = c.id
         WHERE c.kind IN (${placeholders}) ${provisionalFilter}
         GROUP BY c.id
         ORDER BY c.rating DESC`,
      )
      .all(...wanted) as Array<Record<string, number | string | null>>;

    return rows.map((row) => {
      const matches = Number(row["matches"] ?? 0);
      const rounds = Number(row["roundsFired"] ?? 0);
      const decisions = Number(row["decisions"] ?? 0);
      const failures = Number(row["failures"] ?? 0);
      const costUsd = Number(row["costUsd"] ?? 0);
      return {
        competitorId: String(row["competitorId"]),
        kind: String(row["kind"]) as CompetitorKind,
        name: String(row["name"]),
        provider: String(row["provider"]),
        model: String(row["model"]),
        policyVersion: String(row["policyVersion"]),
        schema: (String(row["schema"] ?? "tactical") === "raw" ? "raw" : "tactical") as "raw" | "tactical",
        provisional: Number(row["provisional"] ?? 0) === 1,
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
        failureRate: decisions + failures > 0 ? failures / (decisions + failures) : 0,
        avgLatencyMs: Number(row["avgLatencyMs"] ?? 0),
        costUsd,
        costPerMatchUsd: matches ? costUsd / matches : 0,
      };
    });
  }

  async listMatches(options: { limit: number; userId?: string | undefined }): Promise<MatchRow[]> {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.scenario_id AS scenarioId, m.seed, m.created_at AS createdAt, m.duration_s AS durationS,
                m.winner, m.reason, m.origin, m.verified,
                (SELECT json_group_array(json_object('aircraftId', p.aircraft_id, 'competitorId', p.competitor_id,
                                                     'name', COALESCE(c.name, p.competitor_id),
                                                     'result', p.result, 'hitsScored', p.hits_scored,
                                                     'costUsd', p.cost_usd))
                 FROM participants p LEFT JOIN competitors c ON c.id = p.competitor_id
                 WHERE p.match_id = m.id) AS participants
         FROM matches m
         WHERE (? IS NULL OR m.submitted_by = ?)
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(options.userId ?? null, options.userId ?? null, options.limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row["id"]),
      scenarioId: String(row["scenarioId"]),
      seed: Number(row["seed"]),
      createdAt: String(row["createdAt"]),
      durationS: Number(row["durationS"]),
      winner: (row["winner"] as string | null) ?? null,
      reason: (row["reason"] as string | null) ?? null,
      origin: String(row["origin"] ?? "headless"),
      verified: Number(row["verified"] ?? 0) === 1,
      participants: JSON.parse(String(row["participants"] ?? "[]")) as MatchRow["participants"],
    }));
  }

  async getMatch(id: string): Promise<Record<string, unknown> | undefined> {
    const row = this.db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return { ...row, summary: JSON.parse(String(row["summary_json"])) as unknown, summary_json: undefined };
  }

  async getReplay(id: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT replay_json FROM matches WHERE id = ?").get(id) as
      | { replay_json?: string | null }
      | undefined;
    return row?.replay_json ?? undefined;
  }

  async publicUsageToday(provider: string): Promise<{ decisions: number; costUsd: number }> {
    const row = this.db
      .prepare("SELECT decisions, cost_usd AS costUsd FROM public_usage WHERE day = ? AND provider = ?")
      .get(utcDay(), provider) as { decisions?: number; costUsd?: number } | undefined;
    return { decisions: Number(row?.decisions ?? 0), costUsd: Number(row?.costUsd ?? 0) };
  }

  async recordPublicUsage(provider: string, costUsd: number): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO public_usage (day, provider, decisions, cost_usd)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(day, provider) DO UPDATE SET
           decisions = decisions + 1, cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(utcDay(), provider, Number.isFinite(costUsd) ? costUsd : 0);
  }

  async openLiveMatch(ticket: { id: string; userId?: string | undefined; opponentKind: string }): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO live_matches (id, created_at, user_id, opponent_kind, decisions_served, cost_usd, settled)
         VALUES (?, ?, ?, ?, 0, 0, 0)`,
      )
      .run(ticket.id, new Date().toISOString(), ticket.userId ?? null, ticket.opponentKind);
  }

  async noteLiveDecision(id: string, costUsd: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE live_matches SET decisions_served = decisions_served + 1, cost_usd = cost_usd + ?
         WHERE id = ? AND settled = 0`,
      )
      .run(Number.isFinite(costUsd) ? costUsd : 0, id);
  }

  async settleLiveMatch(id: string): Promise<LiveTicket | undefined> {
    // Only an unsettled ticket may be claimed, or reporting the same match
    // twice would answer "counted" twice -- which is a lie even though the
    // recording itself is idempotent.
    const row = this.db.prepare("SELECT * FROM live_matches WHERE id = ? AND settled = 0").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE live_matches SET settled = 1 WHERE id = ?").run(id);
    return {
      id: String(row["id"]),
      userId: (row["user_id"] as string | null) ?? undefined,
      opponentKind: String(row["opponent_kind"]),
      decisionsServed: Number(row["decisions_served"] ?? 0),
      costUsd: Number(row["cost_usd"] ?? 0),
      settled: Number(row["settled"] ?? 0) === 1,
      createdAt: String(row["created_at"]),
    };
  }
}
