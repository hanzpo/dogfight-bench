import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { atmosphere } from "../src/sim/atmosphere";
import { FORM_FACTOR, g1DragCoefficient, kineticEnergyJ, projectileDeceleration, timeOfFlight } from "../src/sim/ballistics";
import { GUN } from "../src/sim/config";
import { solveGunsight } from "../src/sim/gunsight";
import { HIT_VOLUMES, HULL_RADIUS_M, applyHit, createDamageState, isDestroyed } from "../src/sim/damage";
import { fireGun, stepProjectiles } from "../src/sim/gun";
import { Random } from "../src/sim/random";
import { createNeutralMerge, neutralMerge } from "../src/sim/scenario";
import type { MatchState } from "../src/sim/types";

const DT = 1 / 120;

/**
 * Flies a single round on a flat trajectory and records where it is over time.
 * This is the same integrator the simulation uses.
 */
function flyRound(altitudeM: number, elevationRad = 0) {
  const air = atmosphere(altitudeM);
  const velocity = new Vector3(0, Math.sin(elevationRad), Math.cos(elevationRad)).multiplyScalar(
    GUN.muzzleVelocityMps,
  );
  const position = new Vector3(0, altitudeM, 0);
  const samples: { t: number; range: number; speed: number; drop: number }[] = [];
  for (let t = 0; t < GUN.maxLifeSeconds; t += DT) {
    const sample = atmosphere(position.y);
    const speed = velocity.length();
    const decel = projectileDeceleration(speed, sample.densityKgM3, sample.speedOfSoundMps);
    velocity.addScaledVector(velocity.clone().normalize(), -decel * DT);
    velocity.y -= 9.80665 * DT;
    position.addScaledVector(velocity, DT);
    samples.push({ t: t + DT, range: position.z, speed: velocity.length(), drop: altitudeM - position.y });
  }
  void air;
  return {
    at(rangeM: number) {
      return samples.find((sample) => sample.range >= rangeM) ?? samples[samples.length - 1]!;
    },
  };
}

describe("20 mm ballistics", () => {
  it("follows the G1 drag curve through the transonic rise", () => {
    expect(g1DragCoefficient(0.5)).toBeCloseTo(0.2217, 3);
    expect(g1DragCoefficient(1.2)).toBeCloseTo(0.5386, 3);
    // Drag peaks just above Mach 1 and falls again at high supersonic speed.
    expect(g1DragCoefficient(1.2)).toBeGreaterThan(g1DragCoefficient(0.8));
    expect(g1DragCoefficient(3.0)).toBeLessThan(g1DragCoefficient(1.2));
    // The round is a bit slipperier than the G1 standard projectile.
    expect(FORM_FACTOR).toBeGreaterThan(0.6);
    expect(FORM_FACTOR).toBeLessThan(1.0);
  });

  it("reaches 1000 m in roughly the published time of flight", () => {
    const shot = flyRound(4_500);
    const thousand = shot.at(1_000);
    // Gun-camera and tabular data put a 20 mm round at 1 km in about 1.1-1.4 s.
    expect(thousand.t).toBeGreaterThan(1.0);
    expect(thousand.t).toBeLessThan(1.45);
    // It should still be supersonic and carrying most of its energy.
    expect(thousand.speed).toBeGreaterThan(550);
    expect(thousand.speed).toBeLessThan(800);
  });

  it("loses speed monotonically and drops under gravity", () => {
    const shot = flyRound(4_500);
    const near = shot.at(500);
    const far = shot.at(1_500);
    expect(near.speed).toBeGreaterThan(far.speed);
    expect(far.drop).toBeGreaterThan(near.drop);
    // Drop is a bit less than the drag-free 0.5 g t^2, because drag acts on the
    // vertical component of velocity too.
    const dragFree = 0.5 * 9.80665 * far.t * far.t;
    expect(far.drop).toBeGreaterThan(dragFree * 0.7);
    expect(far.drop).toBeLessThan(dragFree);
  });

  it("shoots flatter in thin air than at sea level", () => {
    const low = flyRound(0).at(1_500);
    const high = flyRound(9_000).at(1_500);
    expect(high.speed).toBeGreaterThan(low.speed);
    expect(high.t).toBeLessThan(low.t);
  });

  it("still carries lethal energy at typical guns range", () => {
    const shot = flyRound(4_500);
    expect(kineticEnergyJ(shot.at(1_200).speed)).toBeGreaterThan(10_000);
  });
});

describe("the gun", () => {
  function firingState(): { state: MatchState; rng: Random; nextId: () => number } {
    const state = createNeutralMerge(neutralMerge);
    let id = 1;
    return { state, rng: new Random(neutralMerge.seed), nextId: () => id++ };
  }

  it("needs to spin up before the first round leaves the muzzle", () => {
    const { state, rng, nextId } = firingState();
    const shooter = state.aircraft[0]!;
    shooter.controls.fire = true;
    fireGun(state, shooter, DT, rng, nextId);
    expect(state.projectiles).toHaveLength(0);
    expect(shooter.gunSpin).toBeGreaterThan(0);

    for (let i = 0; i < GUN.spinUpSeconds / DT + 1; i += 1) fireGun(state, shooter, DT, rng, nextId);
    expect(state.projectiles.length).toBeGreaterThan(0);
  });

  it("fires at the rated rate and runs out of ammunition", () => {
    const { state, rng, nextId } = firingState();
    const shooter = state.aircraft[0]!;
    shooter.controls.fire = true;
    shooter.gunSpin = 1;
    for (let i = 0; i < 1 / DT; i += 1) fireGun(state, shooter, DT, rng, nextId);
    expect(GUN.ammunition - shooter.ammo).toBe(GUN.ratePerSecond);

    for (let i = 0; i < 10 / DT; i += 1) fireGun(state, shooter, DT, rng, nextId);
    expect(shooter.ammo).toBe(0);
    expect(state.events.some((event) => event.type === "winchester")).toBe(true);
  });

  it("inherits the aircraft's velocity", () => {
    const { state, rng, nextId } = firingState();
    const shooter = state.aircraft[0]!;
    shooter.controls.fire = true;
    shooter.gunSpin = 1;
    while (state.projectiles.length === 0) fireGun(state, shooter, DT, rng, nextId);
    const round = state.projectiles[0]!;
    expect(round.velocity.length()).toBeGreaterThan(GUN.muzzleVelocityMps + 200);
    expect(round.velocity.clone().sub(shooter.velocity).length()).toBeCloseTo(GUN.muzzleVelocityMps, 0);
  });

  it("disperses rounds by a few milliradians and repeats exactly for a seed", () => {
    const runs = [0, 1].map(() => {
      const { state, rng, nextId } = firingState();
      const shooter = state.aircraft[0]!;
      shooter.controls.fire = true;
      shooter.gunSpin = 1;
      for (let i = 0; i < 0.6 / DT; i += 1) fireGun(state, shooter, DT, rng, nextId);
      const boresight = new Vector3(0, 0, 1).applyQuaternion(shooter.orientation);
      return state.projectiles.map((round) => {
        const direction = round.velocity.clone().sub(shooter.velocity).normalize();
        return Math.acos(Math.min(1, direction.dot(boresight)));
      });
    });
    expect(runs[0]).toEqual(runs[1]);
    const mean = runs[0]!.reduce((sum, angle) => sum + angle, 0) / runs[0]!.length;
    // Mean of a Rayleigh-distributed miss angle is about 1.25 sigma.
    expect(mean).toBeGreaterThan(GUN.dispersionRad1Sigma * 0.6);
    expect(mean).toBeLessThan(GUN.dispersionRad1Sigma * 2.5);
  });
});

describe("damage", () => {
  it("covers the airframe with sensible hit volumes", () => {
    expect(HIT_VOLUMES).toHaveLength(6);
    // The hull sphere has to enclose everything for broad-phase culling to be safe.
    for (const volume of HIT_VOLUMES) {
      expect(Math.hypot(...volume.offset) + volume.radiusM).toBeLessThanOrEqual(HULL_RADIUS_M + 1e-9);
    }
    // And it should be about the size of an F-16, not a hangar.
    expect(HULL_RADIUS_M).toBeGreaterThan(4);
    expect(HULL_RADIUS_M).toBeLessThan(8);
  });

  it("takes several wing hits to destroy a jet but far fewer through the engine", () => {
    const wingHits = (() => {
      const damage = createDamageState();
      const wing = HIT_VOLUMES.find((volume) => volume.subsystem === "left-wing")!;
      let hits = 0;
      while (!isDestroyed(damage) && hits < 200) {
        applyHit(damage, wing, 1, 1);
        hits += 1;
      }
      return hits;
    })();
    const engineHits = (() => {
      const damage = createDamageState();
      const engine = HIT_VOLUMES.find((volume) => volume.subsystem === "engine")!;
      let hits = 0;
      while (!isDestroyed(damage) && hits < 200) {
        applyHit(damage, engine, 1, 1);
        hits += 1;
      }
      return hits;
    })();
    expect(engineHits).toBeLessThan(wingHits);
    expect(engineHits).toBeGreaterThan(3);
    expect(wingHits).toBeLessThan(30);
  });

  it("degrades the subsystem that was hit", () => {
    const damage = createDamageState();
    const engine = HIT_VOLUMES.find((volume) => volume.subsystem === "engine")!;
    applyHit(damage, engine, 1, 1);
    expect(damage.subsystems.engine).toBeLessThan(1);
    expect(damage.subsystems["left-wing"]).toBe(1);
    expect(damage.fuelLeakKgS).toBeGreaterThan(0);
    expect(damage.hitsTaken).toBe(1);
  });

  it("can take the pilot out through the canopy", () => {
    const damage = createDamageState();
    const cockpit = HIT_VOLUMES.find((volume) => volume.subsystem === "cockpit")!;
    applyHit(damage, cockpit, 1, 0);
    expect(damage.pilotIncapacitated).toBe(true);
    expect(isDestroyed(damage)).toBe(true);
  });

  it("scores low-energy hits as less damaging", () => {
    const wing = HIT_VOLUMES.find((volume) => volume.subsystem === "left-wing")!;
    const hot = createDamageState();
    const cold = createDamageState();
    applyHit(hot, wing, 1, 1);
    applyHit(cold, wing, 0.3, 1);
    expect(cold.integrity).toBeGreaterThan(hot.integrity);
  });
});

/**
 * Where a round actually ends up after `seconds`.
 *
 * Rounds leave along the gun line but inherit the aircraft's velocity, which is
 * a degree or so below the nose at trim, and then drop. Placing a target by eye
 * on the boresight therefore tests the author's trigonometry rather than the
 * collision code, so the tests below put the target on the real trajectory.
 */
function roundPositionAfter(state: MatchState, shooter: MatchState["aircraft"][number], seconds: number): Vector3 {
  const probe = { ...state, projectiles: [], events: [] } as MatchState;
  const scratch = {
    ...shooter,
    controls: { ...shooter.controls, fire: true },
    gunSpin: 1,
    gunAccumulator: 0,
    ammo: 10,
  };
  const rng = new Random(99);
  let id = 1;
  while (probe.projectiles.length === 0) fireGun(probe, scratch, DT, rng, () => id++);
  probe.projectiles.length = 1;
  for (let t = 0; t < seconds; t += DT) stepProjectiles(probe, DT, rng);
  return probe.projectiles[0]?.position.clone() ?? shooter.position.clone();
}

describe("hit resolution", () => {
  it("registers a hit on a jet parked in front of the gun and not on the shooter", () => {
    const state = createNeutralMerge(neutralMerge);
    const [shooter, target] = state.aircraft;
    // Park the target where the rounds will actually be half a second out.
    target!.position.copy(roundPositionAfter(state, shooter!, 0.5));
    target!.velocity.set(0, 0, 0);
    target!.orientation.copy(shooter!.orientation);
    shooter!.controls.fire = true;
    shooter!.gunSpin = 1;

    const rng = new Random(1);
    let id = 1;
    for (let i = 0; i < 2 / DT; i += 1) {
      fireGun(state, shooter!, DT, rng, () => id++);
      stepProjectiles(state, DT, rng);
      state.time += DT;
    }
    expect(state.events.filter((event) => event.type === "hit").length).toBeGreaterThan(5);
    expect(target!.damage.hitsTaken).toBeGreaterThan(5);
    expect(shooter!.damage.hitsTaken).toBe(0);
  });

  it("does not let rounds tunnel through a fast crossing target", () => {
    const state = createNeutralMerge(neutralMerge);
    const [shooter, target] = state.aircraft;
    const impactPoint = roundPositionAfter(state, shooter!, 0.6);
    const gunLine = impactPoint.clone().sub(shooter!.position).normalize();
    target!.position.copy(impactPoint).addScaledVector(gunLine, 150);
    target!.orientation
      .copy(shooter!.orientation)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI));
    // Fly it straight back down the gun line at 250 m/s, so closure is 500 m/s
    // and a round crosses the jet in far less than one tick.
    target!.velocity.copy(gunLine).multiplyScalar(-250);
    shooter!.controls.fire = true;
    shooter!.gunSpin = 1;

    const rng = new Random(2);
    let id = 1;
    for (let i = 0; i < 1 / DT; i += 1) {
      fireGun(state, shooter!, DT, rng, () => id++);
      stepProjectiles(state, DT, rng);
      for (const aircraft of state.aircraft) aircraft.position.addScaledVector(aircraft.velocity, DT);
      state.time += DT;
    }
    expect(target!.damage.hitsTaken).toBeGreaterThan(0);
  });
});

describe("the closed-form time of flight", () => {
  it("agrees with the numerical trajectory it replaces", () => {
    const air = atmosphere(4_500);
    const shot = flyRound(4_500);
    for (const range of [500, 1_000, 1_500, 2_000]) {
      const marched = shot.at(range);
      const closed = timeOfFlight(range, GUN.muzzleVelocityMps, air.densityKgM3, air.speedOfSoundMps);
      // Within a few percent is plenty for a gun solution.
      expect(Math.abs(closed.seconds - marched.t) / marched.t).toBeLessThan(0.08);
      expect(Math.abs(closed.impactSpeedMps - marched.speed) / marched.speed).toBeLessThan(0.1);
    }
  });
});

describe("the gunsight", () => {
  it("stays finite at any range and aspect", () => {
    const state = createNeutralMerge(neutralMerge);
    const [shooter, target] = state.aircraft;
    for (const range of [50, 500, 2_000, 8_000, 40_000]) {
      for (const bearing of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
        target!.position
          .copy(shooter!.position)
          .addScaledVector(new Vector3(Math.sin(bearing), 0, Math.cos(bearing)), range);
        const solution = solveGunsight({
          position: shooter!.position,
          velocity: shooter!.velocity,
          orientation: shooter!.orientation,
          targetPosition: target!.position,
          targetVelocity: target!.velocity,
        });
        expect(Number.isFinite(solution.predictedMissM), `miss at ${range} m`).toBe(true);
        expect(Number.isFinite(solution.timeOfFlightS)).toBe(true);
        expect(solution.timeOfFlightS).toBeLessThanOrEqual(GUN.maxLifeSeconds);
        expect(solution.predictedMissM).toBeLessThanOrEqual(solution.leadRangeM + 1);
      }
    }
  });

  it("aims above the target to compensate for the drop", () => {
    const state = createNeutralMerge(neutralMerge);
    const [shooter, target] = state.aircraft;
    // A stationary target one kilometre straight ahead.
    const nose = new Vector3(0, 0, 1).applyQuaternion(shooter!.orientation);
    target!.position.copy(shooter!.position).addScaledVector(nose, 1_000);
    target!.velocity.set(0, 0, 0);
    const solution = solveGunsight({
      position: shooter!.position,
      velocity: shooter!.velocity,
      orientation: shooter!.orientation,
      targetPosition: target!.position,
      targetVelocity: target!.velocity,
    });
    // Rounds fall a few metres over a kilometre, so the sight must aim high.
    const straightAt = target!.position.clone().sub(shooter!.position).normalize();
    expect(solution.direction.y).toBeGreaterThan(straightAt.y);
    const dropCompensation = Math.tan(Math.acos(solution.direction.dot(straightAt))) * 1_000;
    expect(dropCompensation).toBeGreaterThan(1);
    expect(dropCompensation).toBeLessThan(20);
  });
});
