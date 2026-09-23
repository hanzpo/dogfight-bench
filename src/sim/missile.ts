import { Vector3 } from "three";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { FLARE, MISSILE } from "./config";
import { applyBlast, isDestroyed } from "./damage";
import { bodyAxes } from "./flight-model";
import type { Random } from "./random";
import { terrainHeight } from "./terrain";
import type { AircraftState, FlareState, MatchState, MissileState, MissileTrack } from "./types";
import { clamp } from "../math";

/**
 * Infrared, in units of one F-16 tailpipe at military power seen dead astern.
 *
 * Signal is intensity over range squared, and the seeker locks when it reaches
 * what that reference tailpipe gives at the reference lock range. Everything
 * the pilot can do about being seen -- throttle, aspect, flares -- goes
 * through these few lines, so they are kept plain enough to reason about.
 */
const LOCK_SIGNAL = 1 / (MISSILE.lockRangeReferenceM / 1_000) ** 2;

/** How hot the engine runs: idle is a glow, afterburner is a beacon. */
export function engineHeat(aircraft: AircraftState): number {
  const power = aircraft.engine.power;
  return power <= 1 ? 0.15 + 0.85 * Math.max(power, 0) : 1 + 2 * (power - 1);
}

/** What an observer at `from` sees of this aircraft. */
export function infraredIntensity(target: AircraftState, from: Vector3): number {
  if (!target.alive) return 0;
  const toObserver = from.clone().sub(target.position).normalize();
  const tail = bodyAxes(target.orientation).nose.negate();
  // One looking straight up the tailpipe, nothing from dead ahead: the plume
  // is hidden behind the airframe from the front quarter.
  const astern = (1 + toObserver.dot(tail)) / 2;
  const plume = engineHeat(target) * (0.06 + 0.94 * astern ** 3);
  // The skin, heated by the air: why an all-aspect seeker can see a nose at all.
  const skin = 0.05 * (target.mach / 0.9) ** 2;
  return plume + skin;
}

export function flareIntensity(flare: FlareState): number {
  if (flare.age >= FLARE.burnS) return 0;
  const bloom = clamp(flare.age / 0.15, 0, 1);
  const fade = clamp((FLARE.burnS - flare.age) / 0.6, 0, 1);
  return FLARE.intensity * bloom * fade;
}

/** Signal as a fraction of what it takes to lock. */
export function seekerSignal(intensity: number, rangeM: number): number {
  const rangeKm = Math.max(rangeM / 1_000, 0.1);
  return intensity / (rangeKm * rangeKm) / LOCK_SIGNAL;
}

function angleBetween(a: Vector3, b: Vector3): number {
  const denominator = Math.sqrt(a.lengthSq() * b.lengthSq());
  if (denominator < 1e-12) return 0;
  return Math.acos(clamp(a.dot(b) / denominator, -1, 1));
}

function enemiesOf(state: MatchState, ownerId: string): AircraftState[] {
  const owner = state.aircraft.find((aircraft) => aircraft.id === ownerId);
  return state.aircraft.filter((aircraft) => aircraft.alive && aircraft.id !== ownerId && aircraft.team !== owner?.team);
}

function hostileFlares(state: MatchState, ownerId: string): FlareState[] {
  const enemies = new Set(enemiesOf(state, ownerId).map((aircraft) => aircraft.id));
  return state.flares.filter((flare) => enemies.has(flare.ownerId) && flare.age < FLARE.burnS);
}

/**
 * Gives each new flare in the seeker's view its one chance to pull the track.
 *
 * The chance is the flare's share of the heat, discounted for the seeker's
 * counter-countermeasures. A flare against a jet in afterburner is fighting a
 * bigger signal than one against a jet at idle -- which is why a pilot pulls
 * the throttle back while dispensing.
 */
function flareThatSeduces(
  state: MatchState,
  ownerId: string,
  seekerAt: Vector3,
  lineOfSight: Vector3,
  trackSignal: number,
  seen: number[],
  rng: Random,
): FlareState | undefined {
  for (const flare of hostileFlares(state, ownerId)) {
    if (seen.includes(flare.id)) continue;
    const toFlare = flare.position.clone().sub(seekerAt);
    if (angleBetween(toFlare, lineOfSight) > MISSILE.instantaneousFovRad) continue;
    const signal = seekerSignal(flareIntensity(flare), toFlare.length());
    // Not yet bright enough to judge: it gets its chance once it blooms.
    if (flare.age < 0.15) continue;
    seen.push(flare.id);
    if (seen.length > 64) seen.shift();
    const chance = FLARE.seduction * (signal / (signal + Math.max(trackSignal, 1e-9)));
    if (rng.next() < chance) return flare;
  }
  return undefined;
}

/**
 * The seeker on the rail, before launch.
 *
 * It is slaved to the nose and only sees a few degrees around it, so the
 * pilot has to point at the bandit to get tone. Once it has a lock it tracks
 * on its own out to the gimbal limit.
 */
export function updateSeeker(state: MatchState, aircraft: AircraftState, rng: Random): void {
  const seeker = aircraft.seeker;
  if (!aircraft.alive || aircraft.stores.missiles <= 0) {
    seeker.tone = "off";
    seeker.targetId = undefined;
    seeker.signal = 0;
    return;
  }

  const nose = bodyAxes(aircraft.orientation).nose;

  if (seeker.targetId) {
    const target = state.aircraft.find((candidate) => candidate.id === seeker.targetId);
    if (target?.alive) {
      const lineOfSight = target.position.clone().sub(aircraft.position);
      const signal = seekerSignal(infraredIntensity(target, aircraft.position), lineOfSight.length());
      const held = angleBetween(lineOfSight, nose) <= MISSILE.gimbalLimitRad && signal >= MISSILE.trackHoldFraction;
      const decoy =
        held &&
        flareThatSeduces(state, aircraft.id, aircraft.position, lineOfSight, signal, seeker.flaresSeen, rng);
      if (held && !decoy) {
        seeker.tone = "lock";
        seeker.signal = signal;
        return;
      }
    }
    seeker.targetId = undefined;
  }

  let best: { target: AircraftState; signal: number } | undefined;
  for (const target of enemiesOf(state, aircraft.id)) {
    const lineOfSight = target.position.clone().sub(aircraft.position);
    if (angleBetween(lineOfSight, nose) > MISSILE.acquisitionConeRad) continue;
    const signal = seekerSignal(infraredIntensity(target, aircraft.position), lineOfSight.length());
    if (!best || signal > best.signal) best = { target, signal };
  }

  if (best && best.signal >= 1) {
    seeker.targetId = best.target.id;
    seeker.tone = "lock";
    seeker.signal = best.signal;
  } else if (best && best.signal >= 0.3) {
    seeker.tone = "growl";
    seeker.signal = best.signal;
  } else {
    seeker.tone = "search";
    seeker.signal = best?.signal ?? 0;
  }
}

/** Launches on the press of the pickle button, one missile per press. */
export function launchMissile(
  state: MatchState,
  aircraft: AircraftState,
  dt: number,
  nextId: () => number,
): MissileState | undefined {
  const stores = aircraft.stores;
  stores.launchCooldownS = Math.max(0, stores.launchCooldownS - dt);
  const pressed = aircraft.controls.missile === true;
  const pressedNow = pressed && !stores.missileHeld;
  stores.missileHeld = pressed;
  if (!pressedNow || !aircraft.alive || stores.missiles <= 0 || stores.launchCooldownS > 0) return undefined;

  const axes = bodyAxes(aircraft.orientation);
  const rail = MISSILE.rails[(stores.missileStations - stores.missiles) % MISSILE.rails.length]!;
  const position = aircraft.position
    .clone()
    .addScaledVector(axes.right, rail[0])
    .addScaledVector(axes.up, rail[1])
    .addScaledVector(axes.nose, rail[2]);

  const track: MissileTrack | undefined = aircraft.seeker.targetId
    ? { kind: "aircraft", id: aircraft.seeker.targetId }
    : undefined;
  const missile: MissileState = {
    id: nextId(),
    ownerId: aircraft.id,
    position,
    previousPosition: position.clone(),
    // Off the rail along the nose, not along the flight path: at high angle
    // of attack the two are twenty degrees apart.
    velocity: axes.nose.clone().multiplyScalar(aircraft.velocity.length()),
    age: 0,
    motorRemainingS: MISSILE.burnS,
    massKg: MISSILE.launchMassKg,
    ...(track ? { track } : {}),
    flaresSeen: [...aircraft.seeker.flaresSeen],
  };
  state.missiles.push(missile);
  stores.missiles -= 1;
  stores.launchCooldownS = MISSILE.launchIntervalS;

  const target = track ? state.aircraft.find((candidate) => candidate.id === track.id) : undefined;
  state.events.push({
    time: state.time,
    type: "missile-launch",
    actorId: aircraft.id,
    ...(target ? { targetId: target.id } : {}),
    detail: target
      ? `${MISSILE.name}, locked at ${(target.position.distanceTo(aircraft.position) / 1_000).toFixed(1)} km`
      : `${MISSILE.name}, boresight with no lock`,
    position: position.toArray() as [number, number, number],
  });
  return missile;
}

/** One press, one salvo, dispensed a quarter of a second apart. */
export function dispenseFlares(
  state: MatchState,
  aircraft: AircraftState,
  dt: number,
  nextId: () => number,
): void {
  const stores = aircraft.stores;
  const pressed = aircraft.controls.flare === true;
  const pressedNow = pressed && !stores.flareHeld;
  stores.flareHeld = pressed;
  if (!aircraft.alive) {
    stores.salvoRemaining = 0;
    return;
  }

  if (pressedNow && stores.salvoRemaining === 0 && stores.flares > 0) {
    stores.salvoRemaining = Math.min(FLARE.salvo, stores.flares);
    stores.salvoTimerS = 0;
    state.events.push({
      time: state.time,
      type: "flares",
      actorId: aircraft.id,
      detail: `${stores.flares - stores.salvoRemaining} remaining`,
    });
  }

  if (stores.salvoRemaining <= 0) return;
  stores.salvoTimerS -= dt;
  if (stores.salvoTimerS > 0) return;

  const axes = bodyAxes(aircraft.orientation);
  const side = stores.flares % 2 === 0 ? 1 : -1;
  const ejection = axes.down
    .clone()
    .addScaledVector(axes.right, 0.35 * side)
    .normalize()
    .multiplyScalar(FLARE.ejectMps);
  state.flares.push({
    id: nextId(),
    ownerId: aircraft.id,
    position: aircraft.position.clone().addScaledVector(axes.nose, -4).addScaledVector(axes.down, 0.8),
    velocity: aircraft.velocity.clone().add(ejection),
    age: 0,
  });
  stores.flares -= 1;
  stores.salvoRemaining -= 1;
  stores.salvoTimerS = FLARE.salvoIntervalS;
}

export function stepFlares(state: MatchState, dt: number): void {
  for (const flare of state.flares) {
    const speed = flare.velocity.length();
    if (speed > 1e-3) flare.velocity.multiplyScalar(Math.max(0, 1 - FLARE.dragPerMetre * speed * dt));
    flare.velocity.y -= GRAVITY_MPS2 * dt;
    flare.position.addScaledVector(flare.velocity, dt);
    flare.age += dt;
  }
  state.flares = state.flares.filter(
    (flare) => flare.age < FLARE.burnS && flare.position.y > terrainHeight(flare.position.x, flare.position.z),
  );
}

/** Zero-lift drag against Mach: a subsonic body, a transonic rise, a supersonic tail-off. */
export function missileZeroLiftDrag(mach: number): number {
  if (mach < 0.8) return 0.4;
  if (mach < 1.1) return 0.4 + ((mach - 0.8) / 0.3) * 0.55;
  return Math.max(0.6, 0.95 - (mach - 1.1) * 0.2);
}

interface Resolved {
  position: Vector3;
  velocity: Vector3;
  signal: number;
}

function resolveTrack(state: MatchState, missile: MissileState): Resolved | undefined {
  const track = missile.track;
  if (!track) return undefined;
  if (track.kind === "aircraft") {
    const target = state.aircraft.find((candidate) => candidate.id === track.id);
    if (!target?.alive) return undefined;
    return {
      position: target.position,
      velocity: target.velocity,
      signal: seekerSignal(infraredIntensity(target, missile.position), target.position.distanceTo(missile.position)),
    };
  }
  const flare = state.flares.find((candidate) => candidate.id === track.id);
  if (!flare) return undefined;
  return {
    position: flare.position,
    velocity: flare.velocity,
    signal: seekerSignal(flareIntensity(flare), flare.position.distanceTo(missile.position)),
  };
}

function lose(state: MatchState, missile: MissileState, reason: string): void {
  missile.track = undefined;
  state.events.push({
    time: state.time,
    type: "missile-lost",
    actorId: missile.ownerId,
    detail: reason,
    position: missile.position.toArray() as [number, number, number],
  });
}

/** The seeker in flight: hold the track, or lose it, or be pulled off it. */
function stepMissileSeeker(state: MatchState, missile: MissileState, rng: Random): Resolved | undefined {
  const heading = missile.velocity.clone().normalize();
  const resolved = resolveTrack(state, missile);

  if (missile.track && !resolved) {
    lose(state, missile, missile.track.kind === "flare" ? "flare burnt out" : "target gone");
  } else if (missile.track && resolved) {
    const lineOfSight = resolved.position.clone().sub(missile.position);
    const range = lineOfSight.length();
    const relative = resolved.velocity.clone().sub(missile.velocity);
    const rate = range > 1 ? lineOfSight.clone().cross(relative).length() / (range * range) : 0;
    // Past the target the line of sight swings through the gimbal limit in a
    // tick; the fuze has already had its chance by then, so say nothing.
    if (angleBetween(lineOfSight, heading) > MISSILE.gimbalLimitRad) {
      if (range > MISSILE.fuzeRadiusM * 4) lose(state, missile, "gimbal limit");
      else missile.track = undefined;
    } else if (rate > MISSILE.trackRateLimitRadS && range > MISSILE.fuzeRadiusM * 4) {
      lose(state, missile, "line of sight too fast to track");
    } else if (resolved.signal < MISSILE.trackHoldFraction) {
      lose(state, missile, "signal faded");
    } else {
      const decoy = flareThatSeduces(state, missile.ownerId, missile.position, lineOfSight, resolved.signal, missile.flaresSeen, rng);
      if (decoy) {
        missile.track = { kind: "flare", id: decoy.id };
        state.events.push({
          time: state.time,
          type: "missile-decoyed",
          actorId: missile.ownerId,
          targetId: decoy.ownerId,
          detail: "seeker took a flare",
          position: missile.position.toArray() as [number, number, number],
        });
        return resolveTrack(state, missile);
      }
      return resolved;
    }
  }

  // No track: look around where the nose points for anything hot enough.
  let best: { track: MissileTrack; signal: number } | undefined;
  for (const target of enemiesOf(state, missile.ownerId)) {
    const lineOfSight = target.position.clone().sub(missile.position);
    if (angleBetween(lineOfSight, heading) > MISSILE.reacquireConeRad) continue;
    const signal = seekerSignal(infraredIntensity(target, missile.position), lineOfSight.length());
    if (signal >= 1 && (!best || signal > best.signal)) best = { track: { kind: "aircraft", id: target.id }, signal };
  }
  // A flare the seeker has already judged and rejected is not a candidate:
  // it knows that one for what it is.
  for (const flare of hostileFlares(state, missile.ownerId)) {
    if (missile.flaresSeen.includes(flare.id)) continue;
    const lineOfSight = flare.position.clone().sub(missile.position);
    if (angleBetween(lineOfSight, heading) > MISSILE.reacquireConeRad) continue;
    const signal = seekerSignal(flareIntensity(flare), lineOfSight.length());
    if (signal >= 1 && (!best || signal > best.signal)) best = { track: { kind: "flare", id: flare.id }, signal };
  }
  if (!best) return undefined;
  missile.track = best.track;
  if (best.track.kind === "flare") missile.flaresSeen.push(best.track.id);
  return resolveTrack(state, missile);
}

/**
 * Proportional navigation: turn at a multiple of the rate the line of sight
 * turns, which puts the missile on a collision course without ever aiming at
 * where the target is now. Gravity is flown out, and whatever the airframe
 * cannot give at this dynamic pressure is simply not given.
 */
function guidance(missile: MissileState, target: Resolved | undefined): Vector3 {
  const command = new Vector3();
  if (target && missile.velocity.lengthSq() > 1) {
    const range = target.position.clone().sub(missile.position);
    const distance = Math.max(range.length(), 1);
    const unit = range.clone().divideScalar(distance);
    const relative = target.velocity.clone().sub(missile.velocity);
    const rotation = range.clone().cross(relative).divideScalar(distance * distance);
    const closing = Math.max(-relative.dot(unit), 50);
    command.copy(rotation.cross(unit)).multiplyScalar(MISSILE.navigationGain * closing);
    command.y += GRAVITY_MPS2;
  }
  const heading = missile.velocity.clone().normalize();
  return command.addScaledVector(heading, -command.dot(heading));
}

/** Where the missile and the target were closest during the tick just flown, as a fraction of it. */
function closestApproach(
  missile: MissileState,
  target: AircraftState,
  dt: number,
): { t: number; distance: number } {
  const targetBefore = target.position.clone().addScaledVector(target.velocity, -dt);
  const start = missile.previousPosition.clone().sub(targetBefore);
  const end = missile.position.clone().sub(target.position);
  const path = end.clone().sub(start);
  const lengthSq = Math.max(path.lengthSq(), 1e-9);
  const t = clamp(-start.dot(path) / lengthSq, 0, 1);
  return { t, distance: start.addScaledVector(path, t).length() };
}

function detonate(state: MatchState, missile: MissileState, target: AircraftState, t: number, dt: number, distance: number, rng: Random): void {
  const burst = missile.previousPosition.clone().lerp(missile.position, t);
  const targetAt = target.position.clone().addScaledVector(target.velocity, -dt * (1 - t));
  const axes = bodyAxes(target.orientation);
  const loss = applyBlast(target.damage, burst, targetAt, axes.right, axes.up, axes.nose, MISSILE.lethalRadiusM, rng.next());
  target.health = target.damage.integrity;
  const where = burst.toArray() as [number, number, number];

  state.events.push({
    time: state.time,
    type: "missile-detonation",
    actorId: missile.ownerId,
    targetId: target.id,
    detail: `${MISSILE.name} burst at ${distance.toFixed(1)} m`,
    position: where,
  });
  if (loss > 0) {
    state.events.push({
      time: state.time,
      type: "hit",
      actorId: missile.ownerId,
      targetId: target.id,
      detail: `${MISSILE.name} blast, ${Math.round(loss * 100)}% of the airframe`,
      position: where,
    });
  }
  if (target.alive && isDestroyed(target.damage)) {
    target.alive = false;
    target.destroyedBy = missile.ownerId;
    target.destroyedReason = target.damage.pilotIncapacitated ? "pilot incapacitated" : `${MISSILE.name}`;
    state.events.push({
      time: state.time,
      type: "kill",
      actorId: missile.ownerId,
      targetId: target.id,
      detail: target.destroyedReason,
      position: where,
    });
  }
}

function expire(state: MatchState, missile: MissileState, reason: string): void {
  state.events.push({
    time: state.time,
    type: "missile-expired",
    actorId: missile.ownerId,
    detail: reason,
    position: missile.position.toArray() as [number, number, number],
  });
}

export function stepMissiles(state: MatchState, dt: number, rng: Random): void {
  const survivors: MissileState[] = [];
  for (const missile of state.missiles) {
    missile.previousPosition.copy(missile.position);
    const target = stepMissileSeeker(state, missile, rng);

    const air = atmosphere(missile.position.y);
    const speed = Math.max(missile.velocity.length(), 1);
    const heading = missile.velocity.clone().divideScalar(speed);
    const mach = speed / air.speedOfSoundMps;
    const pressure = 0.5 * air.densityKgM3 * speed * speed;
    const aerodynamic = pressure * MISSILE.referenceAreaM2;

    const guided = speed >= MISSILE.minGuidedSpeedMps || missile.motorRemainingS > 0;
    const lateral = guided ? guidance(missile, target) : new Vector3();
    const available = Math.min(
      MISSILE.structuralLimitG * GRAVITY_MPS2,
      (aerodynamic * MISSILE.normalForceMax) / missile.massKg,
    );
    if (lateral.length() > available) lateral.setLength(available);

    const normalForce = (missile.massKg * lateral.length()) / Math.max(aerodynamic, 1e-6);
    const drag = (aerodynamic * (missileZeroLiftDrag(mach) + MISSILE.inducedDragK * normalForce ** 2)) / missile.massKg;

    let thrust = 0;
    if (missile.motorRemainingS > 0) {
      const burn = Math.min(dt, missile.motorRemainingS);
      thrust = (MISSILE.thrustN * burn) / dt / missile.massKg;
      missile.massKg -= (MISSILE.propellantKg / MISSILE.burnS) * burn;
      missile.motorRemainingS -= burn;
    }

    const acceleration = lateral.addScaledVector(heading, thrust - drag);
    acceleration.y -= GRAVITY_MPS2;
    missile.velocity.addScaledVector(acceleration, dt);
    missile.position.addScaledVector(missile.velocity, dt);
    missile.age += dt;

    let gone = false;
    if (missile.age >= MISSILE.armingS) {
      for (const aircraft of enemiesOf(state, missile.ownerId)) {
        const approach = closestApproach(missile, aircraft, dt);
        // Past its closest point during this tick, or so close already that
        // waiting for the next one would put it through the airframe.
        const fuzes =
          approach.distance <= MISSILE.fuzeRadiusM && (approach.t < 1 || approach.distance <= MISSILE.fuzeRadiusM / 3);
        if (!fuzes) continue;
        detonate(state, missile, aircraft, approach.t, dt, approach.distance, rng);
        gone = true;
        break;
      }
    }
    if (gone) continue;

    if (missile.position.y <= terrainHeight(missile.position.x, missile.position.z)) {
      expire(state, missile, "hit the ground");
    } else if (missile.age >= MISSILE.maxFlightS) {
      expire(state, missile, "time of flight exceeded");
    } else if (missile.motorRemainingS <= 0 && missile.velocity.length() < MISSILE.minGuidedSpeedMps * 0.8) {
      expire(state, missile, "out of energy");
    } else {
      survivors.push(missile);
    }
  }
  state.missiles = survivors;
}
