import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["TYPESAFE_API_KEY"] = "test-typesafe-key";
  process.env["OPENAI_API_KEY"] = "test-openai-key";
  process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
});
import { SCRIPTED_INFO } from "../src/agents/agent";
import { neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { observationFor } from "../src/sim/telemetry";
import { SqliteStore, competitorFor, competitorIdFor, humanCompetitor } from "../server/store";
import { costUsd, priceOf } from "../server/pricing";
import { SYSTEM_PROMPT, buildBriefing } from "../server/prompt";
import { providerAgent } from "../server/providers";
import { JevProvider } from "../server/providers/jev";
import { OpenAiCompatibleProvider } from "../server/providers/openai";

function sampleObservation() {
  const sim = new DogfightSimulation(neutralMerge);
  for (let i = 0; i < 120 * 15; i += 1) sim.step();
  return observationFor(sim.state, "blue-1", neutralMerge, 3);
}

afterEach(() => vi.unstubAllGlobals());

/**
 * Everything the browser sends arrives as JSON.
 *
 * `JSON.stringify` turns Infinity and NaN into `null`, silently. A turn radius
 * of Infinity -- which is simply what wings-level flight has -- reached the
 * server as null and every server-side provider died on `null.toFixed()`,
 * because every test until this one handed the observation over as an object.
 */
/**
 * JSON.stringify turns Infinity into null, silently. A turn radius of Infinity
 * -- which is what wings-level flight has -- reached the server as null and
 * every server-side provider died on `null.toFixed()`, because every test
 * handed the observation over as an object.
 */
describe("the observation on the wire", () => {
  it("holds no number JSON cannot carry", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const found: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) found.push(`${path} = ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      } else if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
      }
    };
    for (let tick = 0; tick < 120 * 20; tick += 1) {
      sim.step();
      if (tick % 240) continue;
      for (const id of ["blue-1", "red-1"]) walk(observationFor(sim.state, id, neutralMerge, tick), id);
    }
    expect(found).toEqual([]);
  });
});

describe("model briefing", () => {
  it("presents the tactical picture, not a dump of every field", () => {
    const briefing = buildBriefing(sampleObservation());
    for (const heading of ["YOU:", "BANDIT:", "GUNS:", "ARENA:", "CHOOSE ONE MANOEUVRE:"]) {
      expect(briefing).toContain(heading);
    }
    expect(briefing).toMatch(/specific energy|energy \d/i);
    expect(briefing).toContain("predicted miss distance");
    expect(briefing).toContain("lead_pursuit");
    expect(briefing.length).toBeLessThan(6_000);
    expect(SYSTEM_PROMPT).toContain("Corner speed");
  });

  it("says plainly when the jet is threatened or damaged", () => {
    const sim = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 120; i += 1) sim.step();
    const blue = sim.state.aircraft[0]!;
    blue.damage.hitsTaken = 3;
    blue.damage.integrity = 0.5;
    blue.damage.subsystems.engine = 0.4;
    const briefing = buildBriefing(observationFor(sim.state, "blue-1", neutralMerge, 0));
    expect(briefing).toContain("DAMAGED");
    expect(briefing).toContain("engine 40%");
  });
});

describe("pricing", () => {
  it("prices known models and refuses to invent a price", () => {
    expect(priceOf("claude-opus-5")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(priceOf("some-unreleased-model")).toBeUndefined();
    expect(costUsd("claude-opus-5", 1_000_000, 100_000)).toBeCloseTo(5 + 2.5, 6);
    expect(costUsd("some-unreleased-model", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("match store", () => {
  function summaryFor(winnerId: string | undefined) {
    return {
      scenarioId: "test",
      seed: 1,
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

  it("stores matches and aggregates a leaderboard", async () => {
    const store = new SqliteStore(":memory:");
    const competitors = {
      "blue-1": competitorFor(SCRIPTED_INFO("alpha")),
      "red-1": competitorFor(SCRIPTED_INFO("beta")),
    };
    await store.recordMatch({
      id: "m1",
      summary: summaryFor("blue-1"),
      competitors,
      origin: "headless",
      verified: true,
      replayJson: '{"x":1}',
    });

    const board = await store.leaderboard(["scripted"]);
    expect(board).toHaveLength(2);
    const alpha = board.find((row) => row.name === "alpha")!;
    expect(alpha.wins).toBe(1);
    expect(alpha.accuracy).toBeCloseTo(0.04, 6);
    expect(alpha.costPerMatchUsd).toBeCloseTo(0.05, 6);
    expect(alpha.rating).toBeGreaterThan(1500);
    expect(board.find((row) => row.name === "beta")!.rating).toBeLessThan(1500);
    expect(board.find((row) => row.name === "beta")!.failureRate).toBeGreaterThan(0);

    expect(await store.getReplay("m1")).toBe('{"x":1}');
    expect(await store.listMatches({ limit: 50 })).toHaveLength(1);
    store.close();
  });

  it("charges a model for every human that beats it", async () => {
    const store = new SqliteStore(":memory:");
    const model = competitorFor({
      name: "claude",
      provider: "anthropic",
      model: "claude-opus-5",
      policyVersion: "v1",
      schema: "tactical",
    });
    const ratingOf = async () =>
      (await store.leaderboard(["model"])).find((row) => row.competitorId === model.id)!.rating;

    await store.recordMatch({
      id: "one",
      summary: summaryFor("blue-1"),
      competitors: { "blue-1": humanCompetitor("ana", "Ana", false), "red-1": model },
      origin: "live",
      verified: true,
    });
    const afterFirst = await ratingOf();

    await store.recordMatch({
      id: "two",
      summary: summaryFor("blue-1"),
      competitors: { "blue-1": humanCompetitor("ben", "Ben", false), "red-1": model },
      origin: "live",
      verified: true,
    });
    const afterSecond = await ratingOf();

    expect(afterFirst).toBeLessThan(1500);
    expect(afterSecond).toBeLessThan(afterFirst);

    await store.recordMatch({
      id: "two",
      summary: summaryFor("blue-1"),
      competitors: { "blue-1": humanCompetitor("ben", "Ben", false), "red-1": model },
      origin: "live",
      verified: true,
    });
    expect(await ratingOf()).toBe(afterSecond);
    store.close();
  });

  it("gives a stronger rating boost for beating a stronger opponent", async () => {
    const beatWeak = new SqliteStore(":memory:");
    const beatStrong = new SqliteStore(":memory:");
    const challenger = competitorFor(SCRIPTED_INFO("challenger"));
    const headless = { origin: "headless" as const, verified: true };

    for (let i = 0; i < 5; i += 1) {
      await beatStrong.recordMatch({
        id: `warm${i}`,
        summary: summaryFor("blue-1"),
        competitors: {
          "blue-1": competitorFor(SCRIPTED_INFO("strong")),
          "red-1": competitorFor(SCRIPTED_INFO(`fodder${i}`)),
        },
        ...headless,
      });
    }
    await beatStrong.recordMatch({
      id: "final",
      summary: summaryFor("red-1"),
      competitors: { "blue-1": competitorFor(SCRIPTED_INFO("strong")), "red-1": challenger },
      ...headless,
    });
    await beatWeak.recordMatch({
      id: "final",
      summary: summaryFor("red-1"),
      competitors: { "blue-1": competitorFor(SCRIPTED_INFO("weak")), "red-1": challenger },
      ...headless,
    });

    const boardStrong = await beatStrong.leaderboard(["scripted"]);
    const boardWeak = await beatWeak.leaderboard(["scripted"]);
    const strongGain = boardStrong.find((row) => row.name === "challenger")!.rating;
    const weakGain = boardWeak.find((row) => row.name === "challenger")!.rating;
    expect(strongGain).toBeGreaterThan(weakGain);
    beatWeak.close();
    beatStrong.close();
  });

  it("keys a model by provider, model and policy version", () => {
    expect(
      competitorIdFor({ name: "x", provider: "anthropic", model: "claude-opus-5", policyVersion: "2", schema: "tactical" }),
    ).toBe("anthropic:claude-opus-5:2");
  });
});

describe("openai-compatible provider", () => {
  it("parses a structured response and prices it", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ reasoning: "behind them", maneuver: "lag_pursuit", targetG: 6, throttle: "mil", fire: false }) } }],
          usage: { prompt_tokens: 1200, completion_tokens: 60 },
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenAiCompatibleProvider({ model: "claude-opus-5", baseUrl: "https://example.test/v1" });
    const decision = await provider.decide(sampleObservation());
    expect(decision.action).toEqual({ schema: "tactical", maneuver: "lag_pursuit", targetG: 6, throttle: "mil", fire: false });
    expect(decision.rationale).toBe("behind them");
    expect(decision.usage?.costUsd).toBeCloseTo((1200 * 5 + 60 * 25) / 1e6, 9);
  });

  it("turns a nonsense manoeuvre into a safe action rather than crashing", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ maneuver: "barrel_roll_of_doom", targetG: 99, throttle: "ludicrous", fire: "yes" }) } }],
          usage: {},
        }),
        { status: 200 },
      ),
    );
    const decision = await new OpenAiCompatibleProvider({ model: "m", baseUrl: "https://example.test/v1" }).decide(sampleObservation());
    expect(decision.action).toEqual({ schema: "tactical", maneuver: "level", targetG: 9, throttle: "mil", fire: false });
  });

  it("raises a provider error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    await expect(new OpenAiCompatibleProvider({ model: "m", baseUrl: "https://example.test/v1" }).decide(sampleObservation())).rejects.toThrow(/429/);
  });
});

describe("jev provider", () => {
  const MANEUVERS = [
    "pure_pursuit", "lead_pursuit", "lag_pursuit", "break_left", "break_right", "high_yoyo",
    "low_yoyo", "vertical_reversal", "defensive_spiral", "extend", "climb", "dive", "level",
  ];

  function uniform(ids: readonly string[], winner: string, winnerProbability: number) {
    const rest = (1 - winnerProbability) / (ids.length - 1);
    return Object.fromEntries(ids.map((id) => [id, id === winner ? winnerProbability : rest]));
  }

  const choice = (winner: string, confidence = 0.9, ids: readonly string[] = MANEUVERS) => ({
    type: "choice",
    choice: winner,
    confidence,
    probabilities: uniform(ids, winner, 0.7),
  });

  const score = (value: number, confidence = 0.8, levels = 5) => ({
    type: "score",
    score: value,
    confidence,
    probabilities: uniform(
      Array.from({ length: levels }, (_, level) => String(level)),
      String(Math.round(value)),
      0.6,
    ),
  });

  const noul = (value: number) => ({ type: "noul", noul: value });

  const respond = (answers: Record<string, unknown>, usage?: Record<string, number>) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ answers, usage }), { status: 200 }));

  it("flies a manoeuvre, a continuous load factor and a continuous throttle", async () => {
    respond(
      {
        maneuver: choice("lead_pursuit"),
        commitment: score(3.4),
        power: score(3.5),
        fire: noul(0.85),
      },
      { input_tokens: 500, output_tokens: 10, cost_usd: 0.0002 },
    );
    const decision = await new JevProvider().decide(sampleObservation());
    expect(decision.action).toEqual({
      schema: "tactical",
      maneuver: "lead_pursuit",
      targetG: 8.2 + 0.4 * (9 - 8.2),
      throttle: "ab",
      throttleFraction: 0.85 + 0.5 * (1 - 0.85),
      fire: true,
    });
    expect(decision.usage?.costUsd).toBeCloseTo(0.0002, 9);
  });

  it("fires on a plausible solution and holds on a hopeless one", async () => {
    const shot = { maneuver: choice("lag_pursuit"), commitment: score(2), power: score(3) };
    respond({ ...shot, fire: noul(0.52) });
    const fired = await new JevProvider().decide(sampleObservation());
    expect(fired.action.schema === "tactical" && fired.action.fire).toBe(true);

    respond({ ...shot, fire: noul(0.3) });
    const held = await new JevProvider().decide(sampleObservation());
    expect(held.action.schema === "tactical" && held.action.fire).toBe(false);
  });

  it("keeps flying the last manoeuvre when the new one is a guess", async () => {
    const provider = new JevProvider();
    respond({ maneuver: choice("high_yoyo", 0.9), commitment: score(3), power: score(3), fire: noul(0.1) });
    expect((await provider.decide(sampleObservation())).action).toMatchObject({ maneuver: "high_yoyo" });

    respond({ maneuver: choice("extend", 0.05), commitment: score(3), power: score(3), fire: noul(0.1) });
    const held = await provider.decide(sampleObservation());
    expect(held.action).toMatchObject({ maneuver: "high_yoyo" });
    expect(held.rationale).toMatch(/held/);

    // A fresh match must not inherit the previous one's plan. The simulation
    // resets the adapter rather than the provider, so the call has to reach it.
    providerAgent("blue-1", provider).reset!();
    respond({ maneuver: choice("extend", 0.05), commitment: score(3), power: score(3), fire: noul(0.1) });
    expect((await provider.decide(sampleObservation())).action).toMatchObject({ maneuver: "extend" });
  });

  it("reports a distribution for all three kinds of question", async () => {
    respond({ maneuver: choice("break_left"), commitment: score(4), power: score(0), fire: noul(0.3) });
    const decision = await new JevProvider().decide(sampleObservation());
    expect(decision.distributions?.map((entry) => entry.question)).toEqual([
      "manoeuvre",
      "commitment",
      "power",
      "fire",
    ]);
    const commitment = decision.distributions?.find((entry) => entry.question === "commitment");
    expect(commitment?.choice).toBe("On the limiter");
    expect(commitment?.options).toHaveLength(5);
    const fire = decision.distributions?.find((entry) => entry.question === "fire");
    expect(fire?.options).toEqual([
      { id: "hold", probability: 0.7 },
      { id: "shoot", probability: 0.3 },
    ]);
  });

  it("refuses a malformed answer instead of flying it", async () => {
    respond({ maneuver: { choice: "lead_pursuit", confidence: 2, probabilities: {} } });
    await expect(new JevProvider().decide(sampleObservation())).rejects.toThrow(/Invalid TypeSafe/);
  });
});
