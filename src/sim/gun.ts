import { Vector3 } from "three";
import { atmosphere } from "./atmosphere";
import { kineticEnergyJ, projectileDeceleration } from "./ballistics";
import { MIN_LETHAL_ENERGY_J } from "./config";
import { airframe, fromModel } from "./airframes";
import { applyHit, hitVolumesFor, isDestroyed, volumeCenter, type HitVolume } from "./damage";
import { bodyAxes } from "./flight-model";
import type { Random } from "./random";
import type { AircraftState, MatchState, ProjectileState } from "./types";
import { clamp } from "../math";

export function fireGun(
  state: MatchState,
  aircraft: AircraftState,
  dt: number,
  rng: Random,
  nextId: () => number,
): void {
  const frame = airframe(aircraft.airframe);
  const gun = frame.gun;
  const [muzzleRight, muzzleUp, muzzleNose] = fromModel(frame, gun.muzzleOffsetM);
  const wantsToFire = aircraft.alive && aircraft.controls.fire && aircraft.ammo > 0;
  if (!wantsToFire) {
    aircraft.gunSpin = Math.max(0, aircraft.gunSpin - dt / gun.spinDownSeconds);
    aircraft.gunAccumulator = Math.min(aircraft.gunAccumulator, 1);
    if (aircraft.roundsThisBurst > 0 && !aircraft.controls.fire) aircraft.roundsThisBurst = 0;
    return;
  }

  aircraft.gunSpin = Math.min(1, aircraft.gunSpin + dt / gun.spinUpSeconds);

  const axes = bodyAxes(aircraft.orientation);
  const rate = gun.ratePerSecond * (gun.initialRateFraction + (1 - gun.initialRateFraction) * aircraft.gunSpin);
  aircraft.gunAccumulator += rate * dt;
  let fired = 0;
  while (aircraft.gunAccumulator >= 1 && aircraft.ammo > 0) {
    aircraft.gunAccumulator -= 1;
    aircraft.ammo -= 1;
    aircraft.roundsThisBurst += 1;
    fired += 1;

    const direction = axes.nose
      .clone()
      .addScaledVector(axes.up, Math.tan(gun.boresightElevationRad))
      .addScaledVector(axes.right, rng.normal() * gun.dispersionRad1Sigma)
      .addScaledVector(axes.up, rng.normal() * gun.dispersionRad1Sigma)
      .normalize();
    const muzzle = aircraft.position
      .clone()
      .addScaledVector(axes.right, muzzleRight)
      .addScaledVector(axes.up, muzzleUp)
      .addScaledVector(axes.nose, muzzleNose);

    state.projectiles.push({
      id: nextId(),
      ownerId: aircraft.id,
      position: muzzle,
      previousPosition: muzzle.clone(),
      velocity: aircraft.velocity.clone().addScaledVector(direction, gun.muzzleVelocityMps),
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

function segmentPointDistanceSq(a: Vector3, b: Vector3, point: Vector3): number {
  const ab = b.clone().sub(a);
  const lengthSq = Math.max(ab.lengthSq(), 1e-9);
  const t = clamp(point.clone().sub(a).dot(ab) / lengthSq, 0, 1);
  return a.clone().addScaledVector(ab, t).distanceToSquared(point);
}

export function stepProjectiles(state: MatchState, dt: number, rng: Random): void {
  const survivors: ProjectileState[] = [];
  const shooters = new Map(state.aircraft.map((aircraft) => [aircraft.id, airframe(aircraft.airframe).gun]));

  for (const shot of state.projectiles) {
    const gun = shooters.get(shot.ownerId) ?? airframe(undefined).gun;
    shot.previousPosition.copy(shot.position);
    const air = atmosphere(shot.position.y);
    const speed = shot.velocity.length();
    const decel = projectileDeceleration(speed, air.densityKgM3, air.speedOfSoundMps, gun);
    shot.velocity.addScaledVector(shot.velocity.clone().normalize(), -decel * dt);
    shot.velocity.y -= 9.80665 * dt;
    shot.position.addScaledVector(shot.velocity, dt);
    shot.age += dt;

    let consumed = false;
    for (const target of state.aircraft) {
      if (!target.alive || target.id === shot.ownerId) continue;

      const { volumes, hullRadiusM } = hitVolumesFor(airframe(target.airframe));
      const targetPrevious = target.position.clone().addScaledVector(target.velocity, -dt);
      const relativeStart = shot.previousPosition.clone().sub(targetPrevious);
      const relativeEnd = shot.position.clone().sub(target.position);
      if (segmentPointDistanceSq(relativeStart, relativeEnd, new Vector3()) > hullRadiusM * hullRadiusM) {
        continue;
      }

      const axes = bodyAxes(target.orientation);
      let best: HitVolume | undefined;
      let bestDistanceSq = Infinity;
      for (const volume of volumes) {
        const center = volumeCenter(volume, new Vector3(), axes.right, axes.up, axes.nose);
        const distanceSq = segmentPointDistanceSq(relativeStart, relativeEnd, center);
        if (distanceSq <= volume.radiusM * volume.radiusM && distanceSq < bestDistanceSq) {
          best = volume;
          bestDistanceSq = distanceSq;
        }
      }
      if (!best) continue;

      consumed = true;
      const impactEnergy = kineticEnergyJ(shot.velocity.clone().sub(target.velocity).length(), gun);
      if (impactEnergy < MIN_LETHAL_ENERGY_J) break;

      const muzzleEnergy = kineticEnergyJ(gun.muzzleVelocityMps, gun);
      applyHit(target.damage, best, impactEnergy / muzzleEnergy, rng.next(), gun.damageScale);
      target.health = target.damage.integrity;
      target.lastHit = { kind: "gun", name: gun.name, by: shot.ownerId, time: state.time };
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
        target.destroyedWeapon = target.lastHit;
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
    if (!consumed && shot.age < gun.maxLifeSeconds && aboveGround) survivors.push(shot);
  }

  state.projectiles = survivors;
}
