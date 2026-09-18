import { afterEach, describe, expect, it, vi } from "vitest";
import { SCRIPTED_INFO } from "../src/agents/agent";
import { neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { observationFor } from "../src/sim/telemetry";
import { MatchStore, agentKey } from "../server/db";
import { costUsd, priceOf } from "../server/pricing";
import { SYSTEM_PROMPT, buildBriefing } from "../server/prompt";
import { JevProvider } from "../server/providers/jev";
import { OpenAiCompatibleProvider } from "../server/providers/openai";

function sampleObservation() {
  const sim = new DogfightSimulation(neutralMerge);
  for (let i = 0; i < 120 * 15; i += 1) sim.step();
  return observationFor(sim.state, "blue-1", neutralMerge, 3);
}

afterEach(() => vi.unstubAllGlobals());

describe("model briefing", () => {
  it("presents the tactical picture, not a dump of every field", () => {
    const briefing = buildBriefing(sampleObservation());
    for (const heading of ["YOU:", "BANDIT:", "GUNS:", "ARENA:", "CHOOSE ONE MANOEUVRE:"]) {
      expect(briefing).toContain(heading);
    }
    expect(briefing).toMatch(/specific energy|energy \d/i);
    expect(briefing).toContain("predicted miss distance");
    expect(briefing).toContain("lead_pursuit");
    // It has to stay small enough to send once a second.
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

  it("stores matches and aggregates a leaderboard", () => {
    const store = new MatchStore(":memory:");
    const agents = { "blue-1": SCRIPTED_INFO("alpha"), "red-1": SCRIPTED_INFO("beta") };
    store.recordMatch({ id: "m1", summary: summaryFor("blue-1"), agents, replayJson: '{"x":1}' });

    const board = store.leaderboard();
    expect(board).toHaveLength(2);
    const alpha = board.find((row) => row.name === "alpha")!;
    expect(alpha.wins).toBe(1);
    expect(alpha.accuracy).toBeCloseTo(0.04, 6);
    expect(alpha.costPerMatchUsd).toBeCloseTo(0.05, 6);
    expect(alpha.rating).toBeGreaterThan(1500);
    expect(board.find((row) => row.name === "beta")!.rating).toBeLessThan(1500);
    expect(board.find((row) => row.name === "beta")!.failureRate).toBeGreaterThan(0);

    expect(store.getReplay("m1")).toBe('{"x":1}');
    expect(store.listMatches()).toHaveLength(1);
    store.close();
  });

  it("gives a stronger rating boost for beating a stronger opponent", () => {
    const beatWeak = new MatchStore(":memory:");
    const beatStrong = new MatchStore(":memory:");
    const challenger = SCRIPTED_INFO("challenger");

    // Build a strong opponent first by letting it win several matches.
    for (let i = 0; i < 5; i += 1) {
      beatStrong.recordMatch({
        id: `warm${i}`,
        summary: summaryFor("blue-1"),
        agents: { "blue-1": SCRIPTED_INFO("strong"), "red-1": SCRIPTED_INFO(`fodder${i}`) },
      });
    }
    beatStrong.recordMatch({
      id: "final",
      summary: summaryFor("red-1"),
      agents: { "blue-1": SCRIPTED_INFO("strong"), "red-1": challenger },
    });
    beatWeak.recordMatch({
      id: "final",
      summary: summaryFor("red-1"),
      agents: { "blue-1": SCRIPTED_INFO("weak"), "red-1": challenger },
    });

    const strongGain = beatStrong.leaderboard().find((row) => row.name === "challenger")!.rating;
    const weakGain = beatWeak.leaderboard().find((row) => row.name === "challenger")!.rating;
    expect(strongGain).toBeGreaterThan(weakGain);
    beatWeak.close();
    beatStrong.close();
  });

  it("keys an agent by provider, model and policy version", () => {
    expect(agentKey({ name: "x", provider: "anthropic", model: "claude-opus-5", policyVersion: "2", schema: "tactical" }))
      .toBe("anthropic:claude-opus-5:2");
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
    const provider = new OpenAiCompatibleProvider("claude-opus-5", "https://example.test/v1");
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
    const decision = await new OpenAiCompatibleProvider("m", "https://example.test/v1").decide(sampleObservation());
    expect(decision.action).toEqual({ schema: "tactical", maneuver: "level", targetG: 9, throttle: "mil", fire: false });
  });

  it("raises a provider error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    await expect(new OpenAiCompatibleProvider("m", "https://example.test/v1").decide(sampleObservation())).rejects.toThrow(/429/);
  });
});

describe("jev provider", () => {
  const answer = (choice: string, probabilities: Record<string, number>, confidence = 0.9) => ({
    choice,
    confidence,
    probabilities,
  });

  function uniform(ids: readonly string[], winner: string, winnerProbability: number) {
    const rest = (1 - winnerProbability) / (ids.length - 1);
    return Object.fromEntries(ids.map((id) => [id, id === winner ? winnerProbability : rest]));
  }

  it("turns four calibrated choices into one action", async () => {
    const maneuvers = ["pure_pursuit", "lead_pursuit", "lag_pursuit", "break_left", "break_right", "high_yoyo", "low_yoyo", "vertical_reversal", "defensive_spiral", "extend", "climb", "dive", "level"];
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          answers: {
            maneuver: answer("lead_pursuit", uniform(maneuvers, "lead_pursuit", 0.7)),
            target_g: answer("8", uniform(["2", "4", "6", "8", "9"], "8", 0.6)),
            throttle: answer("ab", uniform(["idle", "cruise", "mil", "ab"], "ab", 0.8)),
            fire: answer("FIRE", { FIRE: 0.85, HOLD: 0.15 }),
          },
          usage: { input_tokens: 500, output_tokens: 10, cost_usd: 0.0002 },
        }),
        { status: 200 },
      ),
    );
    const decision = await new JevProvider().decide(sampleObservation());
    expect(decision.action).toEqual({ schema: "tactical", maneuver: "lead_pursuit", targetG: 8, throttle: "ab", fire: true });
    expect(decision.usage?.costUsd).toBeCloseTo(0.0002, 9);
  });

  it("holds fire when the model is not confident, even though FIRE won", async () => {
    const maneuvers = ["pure_pursuit", "lead_pursuit", "lag_pursuit", "break_left", "break_right", "high_yoyo", "low_yoyo", "vertical_reversal", "defensive_spiral", "extend", "climb", "dive", "level"];
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          answers: {
            maneuver: answer("lead_pursuit", uniform(maneuvers, "lead_pursuit", 0.4)),
            target_g: answer("6", uniform(["2", "4", "6", "8", "9"], "6", 0.4)),
            throttle: answer("mil", uniform(["idle", "cruise", "mil", "ab"], "mil", 0.4)),
            fire: answer("FIRE", { FIRE: 0.52, HOLD: 0.48 }),
          },
        }),
        { status: 200 },
      ),
    );
    const decision = await new JevProvider().decide(sampleObservation());
    expect(decision.action.schema).toBe("tactical");
    expect(decision.action.schema === "tactical" && decision.action.fire).toBe(false);
  });

  it("refuses a malformed answer instead of flying it", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ answers: { maneuver: { choice: "lead_pursuit", confidence: 2, probabilities: {} } } }), { status: 200 }),
    );
    await expect(new JevProvider().decide(sampleObservation())).rejects.toThrow(/Invalid TypeSafe/);
  });
});
