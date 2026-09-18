import { describe, expect, it } from "vitest";
import { F16 } from "../src/sim/config";
import { neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { observationFor } from "../src/sim/telemetry";
import { BasicPursuitAgent } from "../src/agents/basic-agent";

describe("dogfight simulation", () => {
  it("creates a symmetric neutral merge", () => {
    const sim = new DogfightSimulation(neutralMerge);
    const [blue, red] = sim.state.aircraft;
    expect(blue?.position.distanceTo(red!.position)).toBe(neutralMerge.startSeparationM);
    expect(blue?.velocity.clone().normalize().dot(red!.velocity.clone().normalize())).toBeCloseTo(-1, 8);
    expect(blue?.ammo).toBe(F16.gun.ammunition);
  });

  it("advances deterministically and preserves perfect-information telemetry", () => {
    const a = new DogfightSimulation(neutralMerge);
    const b = new DogfightSimulation(neutralMerge);
    for (let i = 0; i < 1_200; i++) { a.step(); b.step(); }
    expect(a.state.aircraft[0]?.position.toArray()).toEqual(b.state.aircraft[0]?.position.toArray());
    const observation = observationFor(a.state, "blue-1", neutralMerge, 7);
    expect(observation.aircraft).toHaveLength(2);
    expect(observation.decisionSequence).toBe(7);
    expect(observation.relative.rangeM).toBeGreaterThan(0);
  });

  it("fires finite ammunition as individual projectiles", () => {
    const sim = new DogfightSimulation(neutralMerge);
    sim.state.aircraft[0]!.controls.fire = true;
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.state.aircraft[0]!.ammo).toBe(F16.gun.ammunition - 100);
    expect(sim.state.projectiles.length).toBeGreaterThan(90);
  });

  it("runs an AI-vs-AI match headlessly", async () => {
    const shortScenario = { ...neutralMerge, maxTime: 0.5 };
    const sim = new DogfightSimulation(shortScenario);
    sim.attachAgent("blue-1", new BasicPursuitAgent("blue-test"));
    sim.attachAgent("red-1", new BasicPursuitAgent("red-test"));
    await sim.runHeadless();
    expect(sim.state.finished).toBe(true);
    expect(sim.state.finishReason).toBe("time limit");
    expect(sim.latencyStats()["blue-1"]?.decisions).toBeGreaterThanOrEqual(2);
    expect(sim.latencyStats()["red-1"]?.decisions).toBeGreaterThanOrEqual(2);
  });
});
