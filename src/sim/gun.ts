import { Vector3 } from "three";
import { F16 } from "./config";
import { airDensity } from "./flight-model";
import { Random } from "./random";
import type { AircraftState, MatchState, ProjectileState } from "./types";

const BODY_FORWARD = new Vector3(0, 0, 1);
const BODY_RIGHT = new Vector3(1, 0, 0);
const BODY_UP = new Vector3(0, 1, 0);

export function fireGun(state: MatchState, aircraft: AircraftState, dt: number, rng: Random, nextId: () => number): void {
  if (!aircraft.alive || !aircraft.controls.fire || aircraft.ammo <= 0) {
    aircraft.gunAccumulator = Math.min(aircraft.gunAccumulator, 1);
    return;
  }

  aircraft.gunAccumulator += F16.gun.ratePerSecond * dt;
  let fired = 0;
  while (aircraft.gunAccumulator >= 1 && aircraft.ammo > 0) {
    aircraft.gunAccumulator -= 1;
    aircraft.ammo -= 1;
    fired += 1;
    const forward = BODY_FORWARD.clone().applyQuaternion(aircraft.orientation);
    const right = BODY_RIGHT.clone().applyQuaternion(aircraft.orientation);
    const up = BODY_UP.clone().applyQuaternion(aircraft.orientation);
    forward.addScaledVector(right, rng.normal() * F16.gun.dispersionRad1Sigma);
    forward.addScaledVector(up, rng.normal() * F16.gun.dispersionRad1Sigma).normalize();
    const muzzle = aircraft.position.clone()
      .addScaledVector(forward, 7.2)
      .addScaledVector(right, -0.25)
      .addScaledVector(up, -0.35);
    state.projectiles.push({
      id: nextId(), ownerId: aircraft.id, position: muzzle,
      previousPosition: muzzle.clone(),
      velocity: aircraft.velocity.clone().addScaledVector(forward, F16.gun.muzzleVelocityMps),
      age: 0,
    });
  }
  if (fired > 0) state.events.push({ time: state.time, type: "gun-fired", actorId: aircraft.id, detail: `${fired} rounds` });
}

function segmentSphereHit(a: Vector3, b: Vector3, center: Vector3, radius: number): boolean {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, center.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9)));
  return a.clone().addScaledVector(ab, t).distanceToSquared(center) <= radius * radius;
}

export function stepProjectiles(state: MatchState, dt: number): void {
  const survivors: ProjectileState[] = [];
  for (const shot of state.projectiles) {
    shot.previousPosition.copy(shot.position);
    const speed = shot.velocity.length();
    const area = Math.PI * (F16.gun.projectileDiameterM * 0.5) ** 2;
    const dragN = 0.5 * airDensity(shot.position.y) * speed * speed * F16.gun.dragCoefficient * area;
    shot.velocity.addScaledVector(shot.velocity.clone().normalize(), -(dragN / F16.gun.projectileMassKg) * dt);
    shot.velocity.y -= 9.80665 * dt;
    shot.position.addScaledVector(shot.velocity, dt);
    shot.age += dt;

    let hit = false;
    for (const target of state.aircraft) {
      if (!target.alive || target.id === shot.ownerId) continue;
      if (!segmentSphereHit(shot.previousPosition, shot.position, target.position, 4.2)) continue;
      hit = true;
      target.health = Math.max(0, target.health - 0.4);
      state.events.push({ time: state.time, type: "hit", actorId: shot.ownerId, targetId: target.id });
      if (target.health <= 0) {
        target.alive = false;
        state.events.push({ time: state.time, type: "kill", actorId: shot.ownerId, targetId: target.id });
      }
      break;
    }
    if (!hit && shot.age < F16.gun.maxLifeSeconds && shot.position.y > 0) survivors.push(shot);
  }
  state.projectiles = survivors;
}
