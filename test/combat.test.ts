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
import { createNeutralMerge, neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { EnergyFighterAgent } from "../src/agents/baselines";

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
