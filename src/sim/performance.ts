import { alphaForLiftCoefficient, dragFromLiftCoefficient, liftCoefficient } from "./aero";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { AERO, FLCS, GEOMETRY } from "./config";
import { thrustAtPower } from "./engine";
import { degrees } from "../math";

export interface TurnPoint {
  speedMps: number;
  loadFactor: number;
  turnRateDegS: number;
  turnRadiusM: number;
}

function turnRate(loadFactor: number, speedMps: number): number {
  return (GRAVITY_MPS2 * Math.sqrt(Math.max(loadFactor * loadFactor - 1, 0))) / speedMps;
}

export const LIMITER_CL = liftCoefficient(FLCS.alphaLimitRad);

export function liftLimitedLoadFactor(altitudeM: number, speedMps: number, massKg: number): number {
  const air = atmosphere(altitudeM);
  const qbar = 0.5 * air.densityKgM3 * speedMps * speedMps;
  return (qbar * GEOMETRY.wingAreaM2 * LIMITER_CL) / (massKg * GRAVITY_MPS2);
}

export function availableLoadFactor(altitudeM: number, speedMps: number, massKg: number): number {
  return Math.min(FLCS.maxLoadFactor, liftLimitedLoadFactor(altitudeM, speedMps, massKg));
}

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

export function bestSustainedTurn(altitudeM: number, massKg: number): TurnPoint {
  const best = scanSpeeds(altitudeM, (speed) => turnRate(sustainedLoadFactor(altitudeM, speed, massKg), speed));
  const loadFactor = sustainedLoadFactor(altitudeM, best.speedMps, massKg);
  return {
    speedMps: best.speedMps,
    loadFactor,
    turnRateDegS: degrees(best.value),
    turnRadiusM: best.speedMps / Math.max(best.value, 1e-6),
  };
}

export function cornerSpeed(altitudeM: number, massKg: number): TurnPoint {
  const best = scanSpeeds(altitudeM, (speed) => turnRate(availableLoadFactor(altitudeM, speed, massKg), speed));
  const loadFactor = availableLoadFactor(altitudeM, best.speedMps, massKg);
  return {
    speedMps: best.speedMps,
    loadFactor,
    turnRateDegS: degrees(best.value),
    turnRadiusM: best.speedMps / Math.max(best.value, 1e-6),
  };
}

export function maximumLevelSpeed(altitudeM: number): number {
  const air = atmosphere(altitudeM);
  const mass = 11_105;
  let fastest = 0;
  for (let speed = 100; speed <= 2.3 * air.speedOfSoundMps; speed += 1) {
    if (specificExcessPower(altitudeM, speed, 1, mass) > 0) fastest = speed;
  }
  return fastest;
}

export function stallSpeed(altitudeM: number, massKg: number): number {
  const air = atmosphere(altitudeM);
  return Math.sqrt((2 * massKg * GRAVITY_MPS2) / (air.densityKgM3 * GEOMETRY.wingAreaM2 * LIMITER_CL));
}
