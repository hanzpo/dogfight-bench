import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { MANEUVERS, validateAction } from "../src/agents/action";
import { AgentTimeoutError, SCRIPTED_INFO, decideWithTimeout, resolveAction, validateDecision } from "../src/agents/agent";
import { contextFromObservation, goalDirection, steerToward } from "../src/agents/autopilot";
import { BasicPursuitAgent, EnergyFighterAgent } from "../src/agents/baselines";
import { neutralMerge, scenarioSet } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { observationFor } from "../src/sim/telemetry";
import type { AgentAdapter, AgentDecision } from "../src/agents/agent";

function observe(sim: DogfightSimulation, id = "blue-1") {
  return observationFor(sim.state, id, sim.config, 0);
}

describe("action schema", () => {
  it("coerces anything a model can produce into a valid action", () => {
    expect(validateAction(undefined)).toEqual({
      schema: "tactical",
      maneuver: "level",
      targetG: 4,
      throttle: "mil",
      fire: false,
    });
    expect(validateAction({ maneuver: "nonsense", targetG: 400, throttle: "warp", fire: "yes" })).toEqual({
      schema: "tactical",
      maneuver: "level",
      targetG: 9,
      throttle: "mil",
      fire: false,
    });
    const raw = validateAction({ schema: "raw", controls: { pitch: 5, roll: NaN, yaw: -9, throttle: 2, fire: true } });
    expect(raw).toEqual({
      schema: "raw",
      controls: { pitch: 1, roll: 0, yaw: -1, throttle: 1, fire: true },
    });
  });

  it("accepts a bare controls object as the raw schema", () => {
    const decision = validateDecision({ controls: { pitch: 0.5, roll: 0, yaw: 0, throttle: 1, fire: false } });
    expect(decision.action.schema).toBe("raw");
  });

  it("keeps rationale and usage metadata", () => {
    const decision = validateDecision({
      action: { schema: "tactical", maneuver: "extend", targetG: 2, throttle: "ab", fire: false },
      rationale: "low on energy",
      usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.004 },
    });
    expect(decision.rationale).toBe("low on energy");
    expect(decision.usage?.costUsd).toBeCloseTo(0.004, 6);
  });
});

describe("tactical autopilot", () => {
  it("produces a usable goal direction for every manoeuvre", () => {
    const sim = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 600; i += 1) sim.step();
    const observation = observe(sim);
    for (const maneuver of MANEUVERS) {
      const goal = goalDirection(maneuver, contextFromObservation(observation));
      expect(Number.isFinite(goal.length())).toBe(true);
      expect(goal.length()).toBeCloseTo(1, 6);
    }
  });

  it("aims a lead-pursuit goal ahead of the opponent, not at it", () => {
    const sim = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 120 * 10; i += 1) sim.step();
    const observation = observe(sim);
    const [own, opponent] = [observation.aircraft[0]!, observation.aircraft[1]!];
    const lineOfSight = new Vector3(...opponent.positionM).sub(new Vector3(...own.positionM)).normalize();
    const lead = goalDirection("lead_pursuit", contextFromObservation(observation));
    const lag = goalDirection("lag_pursuit", contextFromObservation(observation));
    expect(lead.dot(lineOfSight)).toBeLessThan(1);
    expect(lead.distanceTo(lineOfSight)).toBeGreaterThan(0);
    expect(lag.distanceTo(lineOfSight)).toBeGreaterThan(0);
  });

  it("rolls toward the goal and only pulls once the turn plane is right", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const own = observe(sim).aircraft[0]!;
    const nose = new Vector3(...own.velocityMps).normalize();

    const right = nose.clone().applyAxisAngle(new Vector3(0, 1, 0), -Math.PI / 3);
    const toRight = steerToward(right, 7, contextFromObservation(observe(sim)));
    expect(toRight.roll).toBeGreaterThan(0.5);

    const left = nose.clone().applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    expect(steerToward(left, 7, contextFromObservation(observe(sim))).roll).toBeLessThan(-0.5);

    const ahead = steerToward(nose, 7, contextFromObservation(observe(sim)));
    expect(Math.abs(ahead.roll)).toBeLessThan(0.2);
    expect(ahead.pitch).toBeLessThan(0.1);
  });

  it("actually turns the aircraft the commanded way", () => {
    for (const [maneuver, sign] of [
      ["break_right", 1],
      ["break_left", -1],
    ] as const) {
      const sim = new DogfightSimulation(neutralMerge);
      const blue = sim.state.aircraft[0]!;
      const startHeading = observe(sim).aircraft[0]!.headingDeg;
      for (let i = 0; i < 120 * 6; i += 1) {
        blue.controls = resolveAction(
          { schema: "tactical", maneuver, targetG: 7, throttle: "ab", fire: false },
          observe(sim),
        );
        sim.step();
      }
      let turned = observe(sim).aircraft[0]!.headingDeg - startHeading;
      if (turned > 180) turned -= 360;
      if (turned < -180) turned += 360;
      expect(Math.sign(turned)).toBe(sign);
      expect(Math.abs(turned)).toBeGreaterThan(40);
    }
  });

  it("climbs and dives when told to", () => {
    for (const [maneuver, sign] of [
      ["climb", 1],
      ["dive", -1],
    ] as const) {
      const sim = new DogfightSimulation(neutralMerge);
      const blue = sim.state.aircraft[0]!;
      const startAltitude = blue.position.y;
      for (let i = 0; i < 120 * 8; i += 1) {
        blue.controls = resolveAction(
          { schema: "tactical", maneuver, targetG: 4, throttle: "ab", fire: false },
          observe(sim),
        );
        sim.step();
      }
      expect(Math.sign(blue.position.y - startAltitude)).toBe(sign);
      expect(Math.abs(blue.position.y - startAltitude)).toBeGreaterThan(300);
    }
  });

  it("holds altitude when told to fly level", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const blue = sim.state.aircraft[0]!;
    const startAltitude = blue.position.y;
    for (let i = 0; i < 120 * 20; i += 1) {
      blue.controls = resolveAction(
        { schema: "tactical", maneuver: "level", targetG: 3, throttle: "mil", fire: false },
        observe(sim),
      );
      sim.step();
    }
    expect(Math.abs(blue.position.y - startAltitude)).toBeLessThan(250);
    expect(blue.flcs.departed).toBe(false);
  });

  it("drives a pursuit manoeuvre to a gun solution", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const blue = sim.state.aircraft[0]!;
    const red = sim.state.aircraft[1]!;
    let bestAimError = Infinity;
    for (let i = 0; i < 120 * 45; i += 1) {
      const observation = observe(sim);
      blue.controls = resolveAction(
        { schema: "tactical", maneuver: "lead_pursuit", targetG: 8, throttle: "ab", fire: false },
        observation,
      );
      red.controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fire: false };
      sim.step();
      if (observation.relative.rangeM < 2_500) {
        bestAimError = Math.min(bestAimError, observation.relative.gunSolution.aimErrorDeg);
      }
    }
    expect(bestAimError).toBeLessThan(5);
  });
});

describe("decision deadlines", () => {
  const slowAgent = (delayMs: number): AgentAdapter => ({
    id: "slow",
    info: SCRIPTED_INFO("slow"),
    decide: (_observation, signal) =>
      new Promise<AgentDecision>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ action: { schema: "tactical", maneuver: "level", targetG: 1, throttle: "mil", fire: false } }),
          delayMs,
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }),
  });

  it("rejects a decision that misses its deadline", async () => {
    const sim = new DogfightSimulation(neutralMerge);
    await expect(decideWithTimeout(slowAgent(200), observe(sim), 20)).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("allows a decision that meets it", async () => {
    const sim = new DogfightSimulation(neutralMerge);
    const decision = await decideWithTimeout(slowAgent(1), observe(sim), 500);
    expect(decision.action.schema).toBe("tactical");
  });

  it("counts timeouts against the agent without stalling the match", async () => {
    const sim = new DogfightSimulation(
      { ...neutralMerge, maxTime: 1 },
      { decisionIntervalS: 0.25, decisionTimeoutMs: 5 },
    );
    sim.attachAgent("blue-1", slowAgent(200));
    await sim.runHeadless();
    expect(sim.agentStats()["blue-1"]?.timeouts).toBeGreaterThan(0);
    expect(sim.state.aircraft[0]!.alive).toBe(true);
  });

  it("abandons a match when an agent blows its inference budget", async () => {
    const expensive: AgentAdapter = {
      id: "expensive",
      info: SCRIPTED_INFO("expensive"),
      decide: async () => ({
        action: { schema: "tactical", maneuver: "level", targetG: 1, throttle: "mil", fire: false } as const,
        usage: { costUsd: 1 },
      }),
    };
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 20 }, { inferenceBudgetUsd: 2 });
    sim.attachAgent("blue-1", expensive);
    await sim.runHeadless();
    expect(sim.state.finishReason).toContain("inference budget");
    expect(sim.state.winnerId).toBe("red-1");
    expect(sim.agentStats()["blue-1"]?.costUsd).toBeGreaterThan(2);
  });

  it("records every decision for the replay", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 2 });
    sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
    await sim.runHeadless();
    expect(sim.decisions.length).toBeGreaterThan(4);
    expect(sim.decisions[0]!.aircraftId).toBe("blue-1");
    expect(sim.decisions[0]!.action.schema).toBe("tactical");
    expect(sim.decisions[0]!.rationale).toBeTruthy();
  });
});

describe("scripted baselines", () => {
  it("is not biased toward either side in self-play", async () => {
    let blueWins = 0;
    let redWins = 0;
    for (const scenario of scenarioSet(10, { ...neutralMerge, maxTime: 90 })) {
      const sim = new DogfightSimulation(scenario, { recordDecisions: false });
      sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
      sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));
      await sim.runHeadless();
      if (sim.state.winnerId === "blue-1") blueWins += 1;
      if (sim.state.winnerId === "red-1") redWins += 1;
    }
    expect(Math.abs(blueWins - redWins)).toBeLessThanOrEqual(3);
  }, 120_000);

  it("converts a tight gun solution into hits", () => {
    const sim = new DogfightSimulation(neutralMerge, { recordDecisions: false });
    const [blue, red] = sim.state.aircraft;
    red!.position.copy(blue!.position).addScaledVector(blue!.velocity.clone().normalize(), 900);
    red!.velocity.copy(blue!.velocity).multiplyScalar(0.8);
    red!.orientation.copy(blue!.orientation);

    for (let i = 0; i < 120 * 12; i += 1) {
      const observation = observationFor(sim.state, "blue-1", neutralMerge, 0);
      const solution = observation.relative.gunSolution;
      blue!.controls = resolveAction(
        {
          schema: "tactical",
          maneuver: "lead_pursuit",
          targetG: 7,
          throttle: "mil",
          fire: solution.inLethalRange && solution.predictedMissM < 15,
        },
        observation,
      );
      red!.controls = resolveAction(
        { schema: "tactical", maneuver: "level", targetG: 2, throttle: "cruise", fire: false },
        observationFor(sim.state, "red-1", neutralMerge, 0),
      );
      sim.step();
      if (!red!.alive) break;
    }
    expect(red!.damage.hitsTaken).toBeGreaterThan(0);
    expect(blue!.damage.hitsTaken).toBe(0);
  }, 60_000);
});
