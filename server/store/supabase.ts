import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { gzipSync } from "node:zlib";
import type {
  CompetitorKind,
  LeaderboardRow,
  LiveTicket,
  MatchRow,
  RecordedMatch,
  ResultsStore,
} from "./types";

/**
 * Results in Postgres, replays in object storage.
 *
 * This is the deployed configuration. It exists for three things SQLite cannot
 * do: accounts, somewhere to put replays that is not a text column, and a
 * rating that several processes can update without racing each other.
 *
 * Every write goes through a database function rather than a sequence of
 * statements. Elo is a read-modify-write on two rows, so doing it from here
 * would let two matches finishing at the same moment read the same rating and
 * write back contradictory answers -- on a leaderboard many people contribute
 * to, that is not a rare case.
 *
 * The client holds the service role key, which bypasses row level security. It
 * must therefore never be constructed anywhere the browser can reach, which is
 * why this file lives under `server/` alongside the provider credentials.
 */

/** Replays compress by roughly ten to one: they are mostly slowly-varying floats. */
const REPLAY_BUCKET = "replays";

interface CompetitorRow {
  id: string;
  kind: CompetitorKind;
  display_name: string;
  provider: string;
  model: string;
  policy_version: string;
  schema: string;
  rating: number;
  provisional: boolean;
}

interface ParticipantRow {
  competitor_id: string;
  result: string;
  survived: boolean;
  hits_scored: number;
  hits_taken: number;
  rounds_fired: number;
  time_on_target_s: number;
  decisions: number;
  failures: number;
  avg_latency_ms: number;
  cost_usd: number;
}

export class SupabaseStore implements ResultsStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  close(): void {
    // Nothing to close: the client is stateless HTTP.
  }

  async recordMatch(match: RecordedMatch): Promise<void> {
    const { id, summary, competitors, origin, verified, replayJson, submittedBy } = match;

    let replayPath: string | undefined;
    if (replayJson) {
      replayPath = await this.storeReplay(id, replayJson, submittedBy);
    }

    const winner = summary.winnerId ? competitors[summary.winnerId]?.id : undefined;
    const participants = summary.aircraft
      .map((aircraft) => {
        const competitor = competitors[aircraft.id];
        if (!competitor) return undefined;
        const stats = summary.agents[aircraft.id];
        return {
          aircraftId: aircraft.id,
          competitorId: competitor.id,
          team: aircraft.team,
          result: summary.winnerId ? (summary.winnerId === aircraft.id ? "win" : "loss") : "draw",
          survived: aircraft.alive,
          health: aircraft.health,
          hitsScored: aircraft.hitsScored,
          hitsTaken: aircraft.hitsTaken,
          roundsFired: aircraft.roundsFired,
          timeOnTargetS: aircraft.timeOnTargetS,
          timeInZoneS: aircraft.timeInControlZoneS,
          decisions: stats?.decisions ?? 0,
          failures: stats?.failures ?? 0,
          timeouts: stats?.timeouts ?? 0,
          avgLatencyMs: stats?.averageLatencyMs ?? 0,
          costUsd: stats?.costUsd ?? 0,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    const { error } = await this.client.rpc("record_match", {
      p_match: {
        id,
        scenarioId: summary.scenarioId,
        seed: summary.seed,
        durationS: summary.durationS,
        winner: winner ?? "",
        reason: summary.reason ?? "",
        origin,
        verified,
        summary,
        replayPath: replayPath ?? "",
        submittedBy: submittedBy ?? "",
      },
      p_competitors: Object.values(competitors),
      p_participants: participants,
    });
    if (error) throw new Error(`Could not record match: ${error.message}`);
  }

  /**
   * Puts a replay in object storage and returns its path.
   *
   * Compressed, because a replay is a few megabytes of trajectory that
   * compresses about ten to one, and because most of them will never be
   * watched. Failing to store one must not lose the match result, so a storage
   * error is reported and swallowed rather than thrown.
   */
  private async storeReplay(
    matchId: string,
    replayJson: string,
    userId: string | undefined,
  ): Promise<string | undefined> {
    const path = `${userId ?? "server"}/${matchId}.json.gz`;
    const body = gzipSync(Buffer.from(replayJson, "utf8"));
    const { error } = await this.client.storage
      .from(REPLAY_BUCKET)
      .upload(path, body, { contentType: "application/gzip", upsert: true });
    if (error) {
      console.error(`replay upload failed for ${matchId}: ${error.message}`);
      return undefined;
    }
    return path;
  }

  async leaderboard(
    kinds: CompetitorKind[],
    options: { includeProvisional?: boolean } = {},
  ): Promise<LeaderboardRow[]> {
    const wanted = kinds.length ? kinds : (["model", "scripted"] as CompetitorKind[]);

    let query = this.client
      .from("competitors")
      .select("id, kind, display_name, provider, model, policy_version, schema, rating, provisional")
      .in("kind", wanted)
      .order("rating", { ascending: false });
    if (!options.includeProvisional) query = query.eq("provisional", false);
    const { data: competitors, error } = await query;
    if (error) throw new Error(`Could not read the leaderboard: ${error.message}`);

    const ids = (competitors ?? []).map((row) => (row as CompetitorRow).id);
    if (!ids.length) return [];

    const { data: participants, error: participantError } = await this.client
      .from("participants")
      .select(
        "competitor_id, result, survived, hits_scored, hits_taken, rounds_fired, time_on_target_s, decisions, failures, avg_latency_ms, cost_usd",
      )
      .in("competitor_id", ids);
    if (participantError) throw new Error(`Could not read results: ${participantError.message}`);

    // Aggregated here rather than in SQL because PostgREST cannot express a
    // grouped aggregate without another database function, and the row count is
    // small enough that the round trip saved is not worth another migration.
    const byCompetitor = new Map<string, ParticipantRow[]>();
    for (const row of (participants ?? []) as ParticipantRow[]) {
      const bucket = byCompetitor.get(row.competitor_id);
      if (bucket) bucket.push(row);
      else byCompetitor.set(row.competitor_id, [row]);
    }

    return (competitors ?? [])
      .map((entry) => {
        const competitor = entry as CompetitorRow;
        const rows = byCompetitor.get(competitor.id) ?? [];
        const sum = (pick: (row: ParticipantRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
        const matches = rows.length;
        const wins = rows.filter((row) => row.result === "win").length;
        const rounds = sum((row) => row.rounds_fired);
        const decisions = sum((row) => row.decisions);
        const failures = sum((row) => row.failures);
        const hitsScored = sum((row) => row.hits_scored);
        const costUsd = sum((row) => row.cost_usd);
        return {
          competitorId: competitor.id,
          kind: competitor.kind,
          name: competitor.display_name,
          provider: competitor.provider,
          model: competitor.model,
          policyVersion: competitor.policy_version,
          schema: (competitor.schema === "raw" ? "raw" : "tactical") as "raw" | "tactical",
          provisional: competitor.provisional,
          rating: competitor.rating,
          matches,
          wins,
          losses: rows.filter((row) => row.result === "loss").length,
          draws: rows.filter((row) => row.result === "draw").length,
          winRate: matches ? wins / matches : 0,
          hitsScored,
          hitsTaken: sum((row) => row.hits_taken),
          roundsFired: rounds,
          accuracy: rounds ? hitsScored / rounds : 0,
          timeOnTargetS: sum((row) => row.time_on_target_s),
          survivalRate: matches ? rows.filter((row) => row.survived).length / matches : 0,
          decisions,
          failureRate: decisions + failures > 0 ? failures / (decisions + failures) : 0,
          avgLatencyMs: matches ? sum((row) => row.avg_latency_ms) / matches : 0,
          costUsd,
          costPerMatchUsd: matches ? costUsd / matches : 0,
        };
      })
      .filter((row) => row.matches > 0);
  }

  async listMatches(options: { limit: number; userId?: string | undefined }): Promise<MatchRow[]> {
    let query = this.client
      .from("matches")
      .select(
        "id, scenario_id, seed, created_at, duration_s, winner, reason, origin, verified, participants(aircraft_id, competitor_id, result, hits_scored, cost_usd, competitors(display_name))",
      )
      .order("created_at", { ascending: false })
      .limit(options.limit);
    if (options.userId) query = query.eq("submitted_by", options.userId);

    const { data, error } = await query;
    if (error) throw new Error(`Could not read matches: ${error.message}`);

    return (data ?? []).map((entry) => {
      const row = entry as Record<string, unknown>;
      const participants = (row["participants"] ?? []) as Array<Record<string, unknown>>;
      return {
        id: String(row["id"]),
        scenarioId: String(row["scenario_id"]),
        seed: Number(row["seed"]),
        createdAt: String(row["created_at"]),
        durationS: Number(row["duration_s"]),
        winner: (row["winner"] as string | null) ?? null,
        reason: (row["reason"] as string | null) ?? null,
        origin: String(row["origin"]),
        verified: Boolean(row["verified"]),
        participants: participants.map((participant) => ({
          aircraftId: String(participant["aircraft_id"]),
          competitorId: String(participant["competitor_id"]),
          name:
            ((participant["competitors"] as { display_name?: string } | null)?.display_name ??
              String(participant["competitor_id"])),
          result: String(participant["result"]),
          hitsScored: Number(participant["hits_scored"] ?? 0),
          costUsd: Number(participant["cost_usd"] ?? 0),
        })),
      };
    });
  }

  async getMatch(id: string): Promise<Record<string, unknown> | undefined> {
    const { data, error } = await this.client.from("matches").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Could not read match: ${error.message}`);
    return (data as Record<string, unknown> | null) ?? undefined;
  }

  async getReplay(id: string): Promise<string | undefined> {
    const match = await this.getMatch(id);
    const path = match?.["replay_path"];
    if (typeof path !== "string" || !path) return undefined;
    const { data, error } = await this.client.storage.from(REPLAY_BUCKET).download(path);
    if (error || !data) return undefined;
    const buffer = Buffer.from(await data.arrayBuffer());
    // Stored gzipped; older objects may not be.
    const { gunzipSync } = await import("node:zlib");
    try {
      return gunzipSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  async publicUsageToday(provider: string): Promise<{ decisions: number; costUsd: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const { data, error } = await this.client
      .from("public_usage")
      .select("decisions, cost_usd")
      .eq("day", day)
      .eq("provider", provider)
      .maybeSingle();
    if (error) throw new Error(`Could not read the free-tier usage: ${error.message}`);
    const row = data as { decisions?: number; cost_usd?: number } | null;
    return { decisions: Number(row?.decisions ?? 0), costUsd: Number(row?.cost_usd ?? 0) };
  }

  async recordPublicUsage(provider: string, costUsd: number): Promise<void> {
    const { error } = await this.client.rpc("note_public_usage", {
      p_provider: provider,
      p_cost: Number.isFinite(costUsd) ? costUsd : 0,
    });
    if (error) throw new Error(`Could not record free-tier usage: ${error.message}`);
  }

  async openLiveMatch(ticket: { id: string; userId?: string | undefined; opponentKind: string }): Promise<void> {
    const { error } = await this.client.from("live_matches").insert({
      id: ticket.id,
      user_id: ticket.userId ?? null,
      opponent_kind: ticket.opponentKind,
    });
    if (error) throw new Error(`Could not start a match: ${error.message}`);
  }

  async noteLiveDecision(id: string, costUsd: number): Promise<void> {
    // Best effort: losing a tick of the served count must not fail a decision
    // the caller is waiting on.
    const { error } = await this.client.rpc("note_live_decision", {
      p_id: id,
      p_cost: Number.isFinite(costUsd) ? costUsd : 0,
    });
    if (error) console.error(`could not count a served decision: ${error.message}`);
  }

  async settleLiveMatch(id: string): Promise<LiveTicket | undefined> {
    const { data, error } = await this.client.rpc("settle_live_match", { p_id: id });
    if (error) throw new Error(`Could not settle the match: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row) return undefined;
    return {
      id: String(row["id"]),
      userId: (row["user_id"] as string | null) ?? undefined,
      opponentKind: String(row["opponent_kind"]),
      decisionsServed: Number(row["decisions_served"] ?? 0),
      costUsd: Number(row["cost_usd"] ?? 0),
      settled: Boolean(row["settled"]),
      createdAt: String(row["created_at"]),
    };
  }
}
