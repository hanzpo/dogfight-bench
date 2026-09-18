import { Vector3 } from "three";
import { atmosphere } from "./atmosphere";
import { kineticEnergyJ, projectileDeceleration } from "./ballistics";
import { GUN, MIN_LETHAL_ENERGY_J } from "./config";
import { HIT_VOLUMES, HULL_RADIUS_M, applyHit, isDestroyed, volumeCenter } from "./damage";
import { bodyAxes } from "./flight-model";
import type { Random } from "./random";
import type { AircraftState, MatchState, ProjectileState } from "./types";

const MUZZLE_ENERGY_J = kineticEnergyJ(GUN.muzzleVelocityMps);

/**
 * Fires the M61A1 for one tick.
 *
 * The rotor spins up over a fifth of a second and the rate of fire ramps with
 * it, so the first rounds leave almost immediately and the gun reaches its full
 * cadence shortly after. It also keeps turning for a moment after the trigger
 * is released, which is what makes short bursts work. Rounds inherit the
 * aircraft's velocity and dispersion is seeded, so a match replays bit-for-bit.
 */
export function fireGun(
  state: MatchState,
  aircraft: AircraftState,
  dt: number,
  rng: Random,
  nextId: () => number,
): void {
  const wantsToFire = aircraft.alive && aircraft.controls.fire && aircraft.ammo > 0;
  if (!wantsToFire) {
    // The rotor coasts down rather than stopping dead, so a burst fired a
    // moment later starts at speed.
    aircraft.gunSpin = Math.max(0, aircraft.gunSpin - dt / GUN.spinDownSeconds);
    aircraft.gunAccumulator = Math.min(aircraft.gunAccumulator, 1);
    if (aircraft.roundsThisBurst > 0 && !aircraft.controls.fire) aircraft.roundsThisBurst = 0;
    return;
  }

  aircraft.gunSpin = Math.min(1, aircraft.gunSpin + dt / GUN.spinUpSeconds);

  const axes = bodyAxes(aircraft.orientation);
  // Rate ramps with the rotor instead of gating on it.
  const rate = GUN.ratePerSecond * (GUN.initialRateFraction + (1 - GUN.initialRateFraction) * aircraft.gunSpin);
  aircraft.gunAccumulator += rate * dt;
  let fired = 0;
  while (aircraft.gunAccumulator >= 1 && aircraft.ammo > 0) {
    aircraft.gunAccumulator -= 1;
    aircraft.ammo -= 1;
    aircraft.roundsThisBurst += 1;
    fired += 1;

    const direction = axes.nose
      .clone()
      .addScaledVector(axes.up, Math.tan(GUN.boresightElevationRad))
      .addScaledVector(axes.right, rng.normal() * GUN.dispersionRad1Sigma)
      .addScaledVector(axes.up, rng.normal() * GUN.dispersionRad1Sigma)
      .normalize();
    const muzzle = aircraft.position
      .clone()
      .addScaledVector(axes.right, GUN.muzzleOffsetM[0])
      .addScaledVector(axes.up, GUN.muzzleOffsetM[1])
      .addScaledVector(axes.nose, GUN.muzzleOffsetM[2]);

    state.projectiles.push({
      id: nextId(),
      ownerId: aircraft.id,
      position: muzzle,
      previousPosition: muzzle.clone(),
      velocity: aircraft.velocity.clone().addScaledVector(direction, GUN.muzzleVelocityMps),
      age: 0,
    });
  }

  if (fired > 0) {
    state.events.push({
      time: state.time,
      type: "gun-fired",
      actorId: aircraft.id,
      detail: `${fired} rounds, ${aircraft.ammo} remaining`,
    });
  }
  if (aircraft.ammo === 0) {
    state.events.push({ time: state.time, type: "winchester", actorId: aircraft.id });
  }
}

/** Closest approach between a segment and a point, as a squared distance. */
function segmentPointDistanceSq(a: Vector3, b: Vector3, point: Vector3): number {
  const ab = b.clone().sub(a);
  const lengthSq = Math.max(ab.lengthSq(), 1e-9);
  const t = Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / lengthSq));
  return a.clone().addScaledVector(ab, t).distanceToSquared(point);
}

/**
 * Advances every round and resolves hits.
 *
 * Collision is evaluated in the *target's* frame so that closure speed does not
 * let rounds tunnel through the jet between ticks, and the segment is tested
 * against the individual hit volumes rather than one hull sphere.
 */
export function stepProjectiles(state: MatchState, dt: number, rng: Random): void {
  const survivors: ProjectileState[] = [];

  for (const shot of state.projectiles) {
    shot.previousPosition.copy(shot.position);
    const air = atmosphere(shot.position.y);
    const speed = shot.velocity.length();
    const decel = projectileDeceleration(speed, air.densityKgM3, air.speedOfSoundMps);
    shot.velocity.addScaledVector(shot.velocity.clone().normalize(), -decel * dt);
    shot.velocity.y -= 9.80665 * dt;
    shot.position.addScaledVector(shot.velocity, dt);
    shot.age += dt;

    let consumed = false;
    for (const target of state.aircraft) {
      if (!target.alive || target.id === shot.ownerId) continue;

      // Work relative to the target so both bodies' motion is accounted for.
      const targetPrevious = target.position.clone().addScaledVector(target.velocity, -dt);
      const relativeStart = shot.previousPosition.clone().sub(targetPrevious);
      const relativeEnd = shot.position.clone().sub(target.position);
      if (segmentPointDistanceSq(relativeStart, relativeEnd, new Vector3()) > HULL_RADIUS_M * HULL_RADIUS_M) {
        continue;
      }

      const axes = bodyAxes(target.orientation);
      let best: (typeof HIT_VOLUMES)[number] | undefined;
      let bestDistanceSq = Infinity;
      for (const volume of HIT_VOLUMES) {
        const center = volumeCenter(volume, new Vector3(), axes.right, axes.up, axes.nose);
        const distanceSq = segmentPointDistanceSq(relativeStart, relativeEnd, center);
        if (distanceSq <= volume.radiusM * volume.radiusM && distanceSq < bestDistanceSq) {
          best = volume;
          bestDistanceSq = distanceSq;
        }
      }
      if (!best) continue;

      consumed = true;
      const impactEnergy = kineticEnergyJ(shot.velocity.clone().sub(target.velocity).length());
      if (impactEnergy < MIN_LETHAL_ENERGY_J) break;

      applyHit(target.damage, best, impactEnergy / MUZZLE_ENERGY_J, rng.next());
      target.health = target.damage.integrity;
      state.events.push({
        time: state.time,
        type: "hit",
        actorId: shot.ownerId,
        targetId: target.id,
        subsystem: best.subsystem,
        detail: `${Math.round(impactEnergy / 1000)} kJ`,
      });

      if (isDestroyed(target.damage)) {
        target.alive = false;
        target.destroyedBy = shot.ownerId;
        target.destroyedReason = target.damage.pilotIncapacitated ? "pilot incapacitated" : "airframe destroyed";
        state.events.push({
          time: state.time,
          type: "kill",
          actorId: shot.ownerId,
          targetId: target.id,
          detail: target.destroyedReason,
        });
      }
      break;
    }

    const aboveGround = shot.position.y > 0;
    if (!consumed && shot.age < GUN.maxLifeSeconds && aboveGround) survivors.push(shot);
  }

  state.projectiles = survivors;
}
