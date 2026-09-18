import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  MAX_TRACKING_TIME_OF_FLIGHT_S,
  bulletImpactPoint,
  hitThresholdM,
  solveGunsight,
  wouldConnect,
} from "../src/sim/gunsight";
import { GUN } from "../src/sim/config";
import { fireGun } from "../src/sim/gun";
import { Random } from "../src/sim/random";
import { createNeutralMerge, neutralMerge, scenarioSet } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { BasicPursuitAgent, EnergyFighterAgent } from "../src/agents/baselines";

const DT = 1 / 120;

function shooter() {
  const state = createNeutralMerge(neutralMerge);
  return { state, aircraft: state.aircraft[0]!, rng: new Random(7), nextId: (() => { let id = 1; return () => id++; })() };
}

describe("trigger response", () => {
  it("puts rounds out almost immediately rather than gating on spin-up", () => {
    const { state, aircraft, rng, nextId } = shooter();
    aircraft.controls.fire = true;
    let firstRoundAt = Infinity;
    for (let i = 0; i < 1 / DT; i += 1) {
      const before = state.projectiles.length;
      fireGun(state, aircraft, DT, rng, nextId);
      if (state.projectiles.length > before) {
        firstRoundAt = Math.min(firstRoundAt, i * DT);
        break;
      }
    }
    expect(firstRoundAt).toBeLessThan(0.1);
  });

  it("ramps up to the rated rate as the rotor spins", () => {
    const { state, aircraft, rng, nextId } = shooter();
    aircraft.controls.fire = true;
    const count = (seconds: number) => {
      const before = state.projectiles.length;
      for (let i = 0; i < seconds / DT; i += 1) fireGun(state, aircraft, DT, rng, nextId);
      return state.projectiles.length - before;
    };
    const firstQuarter = count(0.25);
    count(0.5);
    const settled = count(0.25);
    expect(firstQuarter).toBeGreaterThan(0);
    expect(firstQuarter).toBeLessThan(settled);
    expect(settled).toBeGreaterThanOrEqual(GUN.ratePerSecond * 0.25 - 1);
  });

  it("still fires when the trigger is tapped in short bursts", () => {
    const { state, aircraft, rng, nextId } = shooter();
    for (let burst = 0; burst < 4; burst += 1) {
      aircraft.controls.fire = true;
      for (let i = 0; i < 0.1 / DT; i += 1) fireGun(state, aircraft, DT, rng, nextId);
      aircraft.controls.fire = false;
      for (let i = 0; i < 0.3 / DT; i += 1) fireGun(state, aircraft, DT, rng, nextId);
    }
    expect(GUN.ammunition - aircraft.ammo).toBeGreaterThan(20);
  });
});

describe("standing orders", () => {
  it("keeps flying a tactical command between decisions", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 8 }, { decisionIntervalS: 1 });
    sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));

    const blue = sim.state.aircraft[0]!;
    let ticks = 0;
    let changes = 0;
    let previous = "";
    await sim.runHeadless(() => {
      ticks += 1;
      const current = `${blue.controls.pitch.toFixed(6)}/${blue.controls.roll.toFixed(6)}/${blue.controls.yaw.toFixed(6)}`;
      if (current !== previous) changes += 1;
      previous = current;
    });

    expect(ticks).toBeGreaterThan(500);
    expect(changes).toBeGreaterThan(ticks * 0.5);
  }, 30_000);

  it("hands the trigger back to a raw-schema agent", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 1 }, { decisionIntervalS: 0.25 });
    sim.attachAgent("blue-1", {
      id: "raw",
      info: { name: "raw", provider: "test", model: "raw", policyVersion: "1", schema: "raw" },
      decide: async () => ({
        action: { schema: "raw", controls: { pitch: 0, roll: 0, yaw: 0, throttle: 1, fire: true } } as const,
      }),
    });
    await sim.runHeadless();
    expect(sim.state.aircraft[0]!.ammo).toBeLessThan(GUN.ammunition);
  }, 30_000);
});

describe("the energy fighter", () => {
  it("holds a speed near corner instead of spiralling down or running away", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 90 }, { recordDecisions: false });
    sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
    sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));

    const blue = sim.state.aircraft[0]!;
    const ratios: number[] = [];
    let ticks = 0;
    await sim.runHeadless(() => {
      ticks += 1;
      if (ticks % 120 !== 0 || !blue.alive) return;
      const corner = Math.sqrt(
        (2 * 9 * blue.massKg * 9.80665) / (1.225 * Math.exp(-blue.position.y / 8_500) * 27.87 * 1.9),
      );
      ratios.push(blue.velocity.length() / corner);
    });

    const late = ratios.slice(Math.floor(ratios.length / 3));
    const mean = late.reduce((sum, value) => sum + value, 0) / Math.max(late.length, 1);
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.75);
  }, 60_000);

  it("beats the naive baseline decisively and shoots far better", async () => {
    let energyWins = 0;
    let basicWins = 0;
    let energyRounds = 0;
    let energyHits = 0;
    let basicRounds = 0;
    let basicHits = 0;

    for (const scenario of scenarioSet(4, { ...neutralMerge, maxTime: 110 })) {
      for (const energyIsBlue of [true, false]) {
        const sim = new DogfightSimulation(scenario, { recordDecisions: false });
        sim.attachAgent("blue-1", energyIsBlue ? new EnergyFighterAgent("blue-1") : new BasicPursuitAgent("blue-1"));
        sim.attachAgent("red-1", energyIsBlue ? new BasicPursuitAgent("red-1") : new EnergyFighterAgent("red-1"));
        await sim.runHeadless();

        const summary = sim.summary();
        const energyId = energyIsBlue ? "blue-1" : "red-1";
        const energy = summary.aircraft.find((aircraft) => aircraft.id === energyId)!;
        const basic = summary.aircraft.find((aircraft) => aircraft.id !== energyId)!;
        energyRounds += energy.roundsFired;
        energyHits += energy.hitsScored;
        basicRounds += basic.roundsFired;
        basicHits += basic.hitsScored;
        if (sim.state.winnerId === energyId) energyWins += 1;
        else if (sim.state.winnerId) basicWins += 1;
      }
    }

    expect(energyWins).toBeGreaterThan(basicWins * 2);
    const energyAccuracy = energyRounds ? energyHits / energyRounds : 0;
    const basicAccuracy = basicRounds ? basicHits / basicRounds : 0;
    expect(energyHits).toBeGreaterThan(0);
    expect(energyAccuracy).toBeGreaterThan(basicAccuracy);
  }, 300_000);
});

describe("the shoot cue", () => {
  it("is offered for a shot that connects and withheld for one that does not", () => {
    const state = createNeutralMerge(neutralMerge);
    const [shooter, bandit] = state.aircraft;
    const nose = new Vector3(0, 0, 1).applyQuaternion(shooter!.orientation);

    bandit!.position.copy(bulletImpactPoint(shooter!.position, shooter!.velocity, shooter!.orientation, 600));
    bandit!.velocity.copy(shooter!.velocity);
    bandit!.orientation.copy(shooter!.orientation);
    const aligned = solveGunsight({
      position: shooter!.position,
      velocity: shooter!.velocity,
      orientation: shooter!.orientation,
      targetPosition: bandit!.position,
      targetVelocity: bandit!.velocity,
    });
    expect(aligned.inLethalRange).toBe(true);
    expect(aligned.predictedMissM).toBeLessThan(hitThresholdM(aligned.leadRangeM));

    const right = new Vector3(0, 1, 0).cross(nose).normalize();
    bandit!.position.addScaledVector(right, 60);
    const displaced = solveGunsight({
      position: shooter!.position,
      velocity: shooter!.velocity,
      orientation: shooter!.orientation,
      targetPosition: bandit!.position,
      targetVelocity: bandit!.velocity,
    });
    expect(displaced.predictedMissM).toBeGreaterThan(hitThresholdM(displaced.leadRangeM));
  });

  it("widens the threshold with range, because the dispersion cone spreads", () => {
    expect(hitThresholdM(2_000)).toBeGreaterThan(hitThresholdM(200));
    expect(hitThresholdM(2_000)).toBeLessThan(30);
  });
});

describe("gun tracking limits", () => {
  it("refuses a shot the bandit would simply fly out of", () => {
    const state = createNeutralMerge(neutralMerge);
    const [shooter, bandit] = state.aircraft;
    const nose = new Vector3(0, 0, 1).applyQuaternion(shooter!.orientation);

    bandit!.position.copy(bulletImpactPoint(shooter!.position, shooter!.velocity, shooter!.orientation, 2_500));
    bandit!.velocity.set(0, 0, 0);
    const distant = solveGunsight({
      position: shooter!.position,
      velocity: shooter!.velocity,
      orientation: shooter!.orientation,
      targetPosition: bandit!.position,
      targetVelocity: bandit!.velocity,
    });
    expect(distant.predictedMissM).toBeLessThan(hitThresholdM(distant.leadRangeM));
    expect(distant.timeOfFlightS).toBeGreaterThan(MAX_TRACKING_TIME_OF_FLIGHT_S);
    expect(wouldConnect(distant)).toBe(false);

    expect(distant.inLethalRange).toBe(true);

    bandit!.position.copy(bulletImpactPoint(shooter!.position, shooter!.velocity, shooter!.orientation, 500));
    const close = solveGunsight({
      position: shooter!.position,
      velocity: shooter!.velocity,
      orientation: shooter!.orientation,
      targetPosition: bandit!.position,
      targetVelocity: bandit!.velocity,
    });
    expect(wouldConnect(close)).toBe(true);
    void nose;
  });
});
