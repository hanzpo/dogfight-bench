import { alphaForLiftCoefficient, dragFromLiftCoefficient, liftCoefficient } from "./aero";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { AERO, FLCS, GEOMETRY } from "./config";
import { thrustAtPower } from "./engine";

/**
 * Closed-form energy-manoeuvrability queries.
 *
 * These are the numbers an air-combat benchmark is actually judged on, so they
 * are computed directly from the aerodynamic model rather than inferred from a
 * control loop. `test/flight-envelope.test.ts` pins them against published
 * F-16 performance, and the telemetry layer hands them to agents so a model can
 * reason about energy instead of guessing.
 */

export interface TurnPoint {
  speedMps: number;
  loadFactor: number;
  turnRateDegS: number;
  turnRadiusM: number;
}

function turnRate(loadFactor: number, speedMps: number): number {
  return (GRAVITY_MPS2 * Math.sqrt(Math.max(loadFactor * loadFactor - 1, 0))) / speedMps;
}

/**
 * Load factor the wing can generate right now, before any structural limit.
 *
 * This uses the lift available at the FLCS angle-of-attack limit rather than
 * the aerodynamic CL_max, because the limiter is what the jet will actually
 * let a pilot have.
 */
export const LIMITER_CL = liftCoefficient(FLCS.alphaLimitRad);

export function liftLimitedLoadFactor(altitudeM: number, speedMps: number, massKg: number): number {
  const air = atmosphere(altitudeM);
  const qbar = 0.5 * air.densityKgM3 * speedMps * speedMps;
  return (qbar * GEOMETRY.wingAreaM2 * LIMITER_CL) / (massKg * GRAVITY_MPS2);
}

/** What the jet can actually pull: the lower of lift limit and structural limit. */
export function availableLoadFactor(altitudeM: number, speedMps: number, massKg: number): number {
  return Math.min(FLCS.maxLoadFactor, liftLimitedLoadFactor(altitudeM, speedMps, massKg));
}

/** Specific excess power, m/s, at a given flight condition and load factor. */
export function specificExcessPower(
  altitudeM: number,
  speedMps: number,
  loadFactor: number,
  massKg: number,
  afterburner = true,
): number {
  const air = atmosphere(altitudeM);
  const qbar = 0.5 * air.densityKgM3 * speedMps * speedMps;
  const mach = speedMps / air.speedOfSoundMps;
  const weight = massKg * GRAVITY_MPS2;
  const cl = (loadFactor * weight) / (qbar * GEOMETRY.wingAreaM2);
  const drag = qbar * GEOMETRY.wingAreaM2 * dragFromLiftCoefficient(cl, mach);
  const thrust = thrustAtPower(afterburner ? 2 : 1, altitudeM, mach);
  return (speedMps * (thrust - drag)) / weight;
}

export { alphaForLiftCoefficient };

/**
 * Sustained load factor at a fixed speed: the load factor at which full
 * afterburner exactly balances drag, so Ps is zero.
 */
export function sustainedLoadFactor(altitudeM: number, speedMps: number, massKg: number): number {
  const ceiling = availableLoadFactor(altitudeM, speedMps, massKg);
  if (specificExcessPower(altitudeM, speedMps, 1, massKg) < 0) return 0;
  let low = 1;
  let high = ceiling;
  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    if (specificExcessPower(altitudeM, speedMps, mid, massKg) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function scanSpeeds(altitudeM: number, score: (speed: number) => number): { speedMps: number; value: number } {
  const air = atmosphere(altitudeM);
  let best = { speedMps: 0, value: -Infinity };
  for (let speed = 80; speed <= 2.1 * air.speedOfSoundMps; speed += 1) {
    const value = score(speed);
    if (value > best.value) best = { speedMps: speed, value };
  }
  return best;
}

/** Best sustained turn the jet can hold at this altitude, across all speeds. */
export function bestSustainedTurn(altitudeM: number, massKg: number): TurnPoint {
  const best = scanSpeeds(altitudeM, (speed) => turnRate(sustainedLoadFactor(altitudeM, speed, massKg), speed));
  const loadFactor = sustainedLoadFactor(altitudeM, best.speedMps, massKg);
  return {
    speedMps: best.speedMps,
    loadFactor,
    turnRateDegS: (best.value * 180) / Math.PI,
    turnRadiusM: best.speedMps / Math.max(best.value, 1e-6),
  };
}

/**
 * Corner velocity: the slowest speed at which the structural limit is
 * reachable, and therefore the highest instantaneous turn rate available.
 */
export function cornerSpeed(altitudeM: number, massKg: number): TurnPoint {
  const best = scanSpeeds(altitudeM, (speed) => turnRate(availableLoadFactor(altitudeM, speed, massKg), speed));
  const loadFactor = availableLoadFactor(altitudeM, best.speedMps, massKg);
  return {
    speedMps: best.speedMps,
    loadFactor,
    turnRateDegS: (best.value * 180) / Math.PI,
    turnRadiusM: best.speedMps / Math.max(best.value, 1e-6),
  };
}

/** Fastest level speed at this altitude, where Ps at 1 g falls to zero. */
export function maximumLevelSpeed(altitudeM: number): number {
  const air = atmosphere(altitudeM);
  const mass = 11_105;
  let fastest = 0;
  for (let speed = 100; speed <= 2.3 * air.speedOfSoundMps; speed += 1) {
    if (specificExcessPower(altitudeM, speed, 1, mass) > 0) fastest = speed;
  }
  return fastest;
}

/** Stall speed in level flight. */
export function stallSpeed(altitudeM: number, massKg: number): number {
  const air = atmosphere(altitudeM);
  return Math.sqrt((2 * massKg * GRAVITY_MPS2) / (air.densityKgM3 * GEOMETRY.wingAreaM2 * LIMITER_CL));
}
