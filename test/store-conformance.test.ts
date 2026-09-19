import { afterAll, describe, expect, it } from "vitest";
import { SCRIPTED_INFO } from "../src/agents/agent";
import { SqliteStore, competitorFor, humanCompetitor, type ResultsStore } from "../server/store";
import { SupabaseStore } from "../server/store/supabase";

/**
 * Both stores answer the same questions the same way.
 *
 * Production runs on Supabase and every other test runs on SQLite, so the two
 * only agree by inspection -- and they have already drifted twice: the
 * leaderboard's rates were computed independently in each, and SQLite handed
 * the same live ticket out twice because it forgot to check whether the ticket
 * was already settled.
 *
 * The Supabase side needs a project to talk to and is skipped without one. Run
 * it against a local stack or a branch, never against the deployment:
 *
 *   STORE_CONFORMANCE_SUPABASE_URL=... STORE_CONFORMANCE_SERVICE_KEY=... npm test
 */
function summary(winnerId: string | undefined) {
  return {
    scenarioId: "conformance",
    seed: 7,
    durationS: 60,
    winnerId,
    reason: "opponent destroyed",
    aircraft: [
      {
        id: "blue-1", team: "blue", alive: winnerId === "blue-1", health: 1, hitsTaken: 0,
        hitsScored: 4, roundsFired: 100, ammoRemaining: 411, fuelRemainingKg: 900,
        timeOnTargetS: 2, timeInControlZoneS: 10,
      },
      {
        id: "red-1", team: "red", alive: winnerId === "red-1", health: 0, hitsTaken: 4,
        hitsScored: 0, roundsFired: 20, ammoRemaining: 491, fuelRemainingKg: 900,
        timeOnTargetS: 0, timeInControlZoneS: 1,
      },
    ],
    agents: {
      "blue-1": { decisions: 60, failures: 0, timeouts: 0, averageLatencyMs: 120, maxLatencyMs: 200, costUsd: 0.05, inputTokens: 1000, outputTokens: 100 },
      "red-1": { decisions: 60, failures: 2, timeouts: 1, averageLatencyMs: 90, maxLatencyMs: 150, costUsd: 0.01, inputTokens: 900, outputTokens: 80 },
    },
  };
}

const supabaseUrl = process.env["STORE_CONFORMANCE_SUPABASE_URL"];
const supabaseKey = process.env["STORE_CONFORMANCE_SERVICE_KEY"];

const backends: Array<{ name: string; open: () => ResultsStore }> = [
  { name: "sqlite", open: () => new SqliteStore(":memory:") },
];
if (supabaseUrl && supabaseKey) {
  backends.push({ name: "supabase", open: () => new SupabaseStore(supabaseUrl, supabaseKey) });
}

const opened: ResultsStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
});

describe.each(backends)("$name results store", ({ open }) => {
  /** A distinct run of ids, so a shared backend does not see another run's rows. */
  const run = Math.random().toString(36).slice(2, 10);
  const id = (name: string) => `${run}-${name}`;

  function store(): ResultsStore {
    const instance = open();
    opened.push(instance);
    return instance;
  }

  it("counts a recorded match into the leaderboard", async () => {
    const results = store();
    const blue = competitorFor(SCRIPTED_INFO(id("alpha")));
    const red = competitorFor(SCRIPTED_INFO(id("beta")));
    await results.recordMatch({
      id: id("m1"),
      summary: summary("blue-1"),
      competitors: { "blue-1": blue, "red-1": red },
      origin: "headless",
      verified: true,
      replayJson: '{"frames":[]}',
    });

    const board = await results.leaderboard(["scripted"]);
    const winner = board.find((row) => row.competitorId === blue.id)!;
    const loser = board.find((row) => row.competitorId === red.id)!;
    expect(winner.wins).toBe(1);
    expect(loser.losses).toBe(1);
    expect(winner.accuracy).toBeCloseTo(0.04, 6);
    expect(winner.rating).toBeGreaterThan(loser.rating);
    expect(loser.failureRate).toBeGreaterThan(0);
    expect(await results.getReplay(id("m1"))).toBe('{"frames":[]}');
  });

  it("hands a live ticket over exactly once", async () => {
    const results = store();
    await results.openLiveMatch({ id: id("live"), opponentKind: "jev" });
    await results.noteLiveDecision(id("live"), 0.01);
    await results.noteLiveDecision(id("live"), 0.01);

    const ticket = await results.settleLiveMatch(id("live"));
    expect(ticket?.opponentKind).toBe("jev");
    expect(ticket?.decisionsServed).toBe(2);
    expect(ticket?.costUsd).toBeCloseTo(0.02, 6);
    // Settling twice is how a result gets counted twice.
    expect(await results.settleLiveMatch(id("live"))).toBeUndefined();
    expect(await results.settleLiveMatch(id("never-opened"))).toBeUndefined();
  });

  it("accumulates free-tier usage per provider", async () => {
    const results = store();
    const provider = id("provider");
    expect(await results.publicUsageToday(provider)).toEqual({ decisions: 0, costUsd: 0 });
    await results.recordPublicUsage(provider, 0.25);
    await results.recordPublicUsage(provider, 0.25);
    const used = await results.publicUsageToday(provider);
    expect(used.decisions).toBe(2);
    expect(used.costUsd).toBeCloseTo(0.5, 6);
    expect((await results.publicUsageToday(id("other"))).decisions).toBe(0);
  });

  it("lists a player's own matches apart from everyone's", async () => {
    const results = store();
    const person = humanCompetitor(id("ana"), "Ana", false);
    const model = competitorFor(SCRIPTED_INFO(id("gamma")));
    await results.recordMatch({
      id: id("mine"),
      summary: summary("blue-1"),
      competitors: { "blue-1": person, "red-1": model },
      origin: "live",
      verified: true,
      submittedBy: person.userId,
    });

    const mine = await results.listMatches({ limit: 50, userId: person.userId });
    expect(mine.map((row) => row.id)).toContain(id("mine"));
    const someoneElse = await results.listMatches({ limit: 50, userId: id("nobody") });
    expect(someoneElse.map((row) => row.id)).not.toContain(id("mine"));
  });
});
