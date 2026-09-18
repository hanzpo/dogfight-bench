import { describe, expect, it } from "vitest";
import { SCRIPTED_INFO } from "../src/agents/agent";
import { BasicPursuitAgent } from "../src/agents/baselines";
import { GUN } from "../src/sim/config";
import { neutralMerge, scenarioSet, scenarioVariant } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { observationFor } from "../src/sim/telemetry";

describe("dogfight simulation", () => {
  it("creates a symmetric neutral merge", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const [blue, red] = sim.state.aircraft;
    expect(blue?.position.distanceTo(red!.position)).toBeCloseTo(neutralMerge.startSeparationM, 6);
    expect(blue?.velocity.clone().normalize().dot(red!.velocity.clone().normalize())).toBeCloseTo(-1, 6);
    expect(blue?.ammo).toBe(GUN.ammunition);
    expect(blue?.massKg).toBeCloseTo(red!.massKg, 6);
  });

  it("advances deterministically from a seed", () => {
    const a = new DogfightSimulation(neutralMerge);
    const b = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 1_200; i += 1) {
      a.step();
      b.step();
    }
    expect(a.state.aircraft[0]?.position.toArray()).toEqual(b.state.aircraft[0]?.position.toArray());
    expect(a.state.aircraft[1]?.orientation.toArray()).toEqual(b.state.aircraft[1]?.orientation.toArray());
  });

  it("serves perfect-information telemetry to both sides", () => {
    const sim = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 240; i += 1) sim.step();

    const observation = observationFor(sim.state, "blue-1", neutralMerge, 7);
    expect(observation.schemaVersion).toBe(2);
    expect(observation.aircraft).toHaveLength(2);
    expect(observation.decisionSequence).toBe(7);
    expect(observation.relative.rangeM).toBeGreaterThan(0);
    expect(observation.relative.closureRateMps).toBeGreaterThan(0);

    const [blue] = observation.aircraft;
    expect(blue!.specificEnergyM).toBeGreaterThan(blue!.altitudeM);
    expect(blue!.availableLoadFactorG).toBeGreaterThan(1);
    expect(blue!.mach).toBeGreaterThan(0.5);
    expect(blue!.fuelKg).toBeGreaterThan(0);
    expect(Object.keys(blue!.subsystems)).toHaveLength(6);

    // Both jets see the same range, from opposite sides.
    const mirrored = observationFor(sim.state, "red-1", neutralMerge, 0);
    expect(mirrored.relative.rangeM).toBeCloseTo(observation.relative.rangeM, 6);
    expect(mirrored.relative.energyAdvantageM).toBeCloseTo(-observation.relative.energyAdvantageM, 6);
  });

  it("reports a gun solution that closes as the jets merge", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const far = observationFor(sim.state, "blue-1", neutralMerge, 0).relative;
    for (let i = 0; i < 120 * 12; i += 1) sim.step();
    const near = observationFor(sim.state, "blue-1", neutralMerge, 0).relative;
    expect(near.rangeM).toBeLessThan(far.rangeM);
    expect(near.gunSolution.timeOfFlightS).toBeLessThan(far.gunSolution.timeOfFlightS);
    expect(far.gunSolution.inLethalRange).toBe(false);
  });

  it("fires finite ammunition as individual projectiles", () => {
    const sim = new DogfightSimulation(neutralMerge);
    sim.state.aircraft[0]!.controls.fire = true;
    for (let i = 0; i < 240; i += 1) {
      sim.state.aircraft[0]!.controls.fire = true;
      sim.step();
    }
    const fired = GUN.ammunition - sim.state.aircraft[0]!.ammo;
    // Two seconds of trigger, minus the barrel spin-up.
    expect(fired).toBeGreaterThan(150);
    expect(fired).toBeLessThan(200);
    expect(sim.state.projectiles.length).toBeGreaterThan(90);
    expect(sim.summary().aircraft[0]!.roundsFired).toBe(fired);
  });

  it("runs an AI-vs-AI match headlessly and reports a summary", async () => {
    const scenario = { ...neutralMerge, maxTime: 2 };
    const sim = new DogfightSimulation(scenario);
    sim.attachAgent("blue-1", new BasicPursuitAgent("blue-test"));
    sim.attachAgent("red-1", new BasicPursuitAgent("red-test"));
    await sim.runHeadless();

    expect(sim.state.finished).toBe(true);
    expect(sim.state.finishReason).toContain("time limit");
    const summary = sim.summary();
    expect(summary.agents["blue-1"]?.decisions).toBeGreaterThanOrEqual(2);
    expect(summary.agents["red-1"]?.failures).toBe(0);
    expect(summary.aircraft).toHaveLength(2);
    expect(summary.durationS).toBeGreaterThanOrEqual(2);
  });

  it("holds the last command when an agent fails, and records the failure", async () => {
    const scenario = { ...neutralMerge, maxTime: 1 };
    const sim = new DogfightSimulation(scenario);
    sim.attachAgent("blue-1", {
      id: "broken",
      info: SCRIPTED_INFO("broken"),
      decide: () => Promise.reject(new Error("model unavailable")),
    });
    await sim.runHeadless();
    expect(sim.state.aircraft[0]!.alive).toBe(true);
    expect(sim.agentStats()["blue-1"]?.failures).toBeGreaterThan(0);
    expect(sim.agentStats()["blue-1"]?.decisions).toBe(0);
  });

  it("kills an aircraft that flies into the ground", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const blue = sim.state.aircraft[0]!;
    blue.position.y = 5;
    blue.velocity.set(0, -200, 0);
    for (let i = 0; i < 20; i += 1) sim.step();
    expect(blue.alive).toBe(false);
    expect(sim.state.events.some((event) => event.type === "ground-impact")).toBe(true);
    expect(sim.state.finished).toBe(true);
    expect(sim.state.winnerId).toBe("red-1");
  });

  it("forfeits a match for leaving the arena", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const blue = sim.state.aircraft[0]!;
    blue.position.x = neutralMerge.arenaRadiusM + 5_000;
    for (let i = 0; i < 120 * 6; i += 1) sim.step();
    expect(blue.alive).toBe(false);
    expect(blue.destroyedReason).toBe("left the arena");
  });

  it("generates reproducible scenario variants that differ from each other", () => {
    expect(scenarioVariant(42)).toEqual(scenarioVariant(42));
    const set = scenarioSet(6);
    expect(new Set(set.map((scenario) => scenario.id)).size).toBe(6);
    for (const scenario of set) {
      expect(scenario.startHeadingCrossingDeg).toBeGreaterThan(100);
      expect(scenario.startHeadingCrossingDeg).toBeLessThanOrEqual(180);
      expect(scenario.startAltitudeM).toBeGreaterThan(2_000);
      expect(new DogfightSimulation(scenario).state.aircraft).toHaveLength(2);
    }
    expect(set[0]!.startLateralOffsetM).not.toBe(set[1]!.startLateralOffsetM);
  });
});

describe("gun solution reporting", () => {
  it("keeps the predicted miss finite however badly the nose is pointed", () => {
    const sim = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 120 * 20; i += 1) sim.step();
    for (const id of ["blue-1", "red-1"]) {
      const solution = observationFor(sim.state, id, neutralMerge, 0).relative;
      expect(Number.isFinite(solution.gunSolution.predictedMissM)).toBe(true);
      // A miss can never be further away than the target is.
      expect(solution.gunSolution.predictedMissM).toBeLessThanOrEqual(solution.gunSolution.leadRangeM + 1);
    }
  });
});

describe("relative geometry", () => {
  it("reports 180 degrees off the tail at a head-on merge", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const relative = observationFor(sim.state, "blue-1", neutralMerge, 0).relative;
    // Nose to nose: as far from their six o'clock as it is possible to be.
    expect(relative.angleOffTailDeg).toBeGreaterThan(175);
    // And they are directly in front of us.
    expect(relative.antennaTrainAngleDeg).toBeLessThan(5);
  });

  it("reports 0 degrees off the tail from directly behind", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const [blue, red] = sim.state.aircraft;
    // Put blue on red's tail, both pointing the same way.
    red!.orientation.copy(blue!.orientation);
    red!.velocity.copy(blue!.velocity);
    red!.position.copy(blue!.position).addScaledVector(blue!.velocity.clone().normalize(), 600);

    const relative = observationFor(sim.state, "blue-1", neutralMerge, 0).relative;
    expect(relative.angleOffTailDeg).toBeLessThan(5);
    expect(relative.antennaTrainAngleDeg).toBeLessThan(5);

    // And the mirror: red sees blue at its six, far off its own tail angle.
    expect(observationFor(sim.state, "red-1", neutralMerge, 0).relative.angleOffTailDeg).toBeGreaterThan(175);
  });
});
