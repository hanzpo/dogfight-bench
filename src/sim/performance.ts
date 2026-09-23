import { alphaForLiftCoefficient, dragFromLiftCoefficient, liftCoefficient } from "./aero";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { F16_FLIGHT, type FlightSpec } from "./config";
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

/** The lift coefficient at the angle-of-attack limit, which is where the flight computer stops the pull. */
export function limiterCl(flight: FlightSpec = F16_FLIGHT): number {
  return liftCoefficient(flight.flcs.alphaLimitRad, flight.aero);
}

export const LIMITER_CL = limiterCl();

export function liftLimitedLoadFactor(
  altitudeM: number,
  speedMps: number,
  massKg: number,
  flight: FlightSpec = F16_FLIGHT,
): number {
  const air = atmosphere(altitudeM);
  const qbar = 0.5 * air.densityKgM3 * speedMps * speedMps;
  return (qbar * flight.geometry.wingAreaM2 * limiterCl(flight)) / (massKg * GRAVITY_MPS2);
}

export function availableLoadFactor(
  altitudeM: number,
  speedMps: number,
  massKg: number,
  flight: FlightSpec = F16_FLIGHT,
): number {
  return Math.min(flight.flcs.maxLoadFactor, liftLimitedLoadFactor(altitudeM, speedMps, massKg, flight));
}

export function specificExcessPower(
  altitudeM: number,
  speedMps: number,
  loadFactor: number,
  massKg: number,
  afterburner = true,
  flight: FlightSpec = F16_FLIGHT,
): number {
  const air = atmosphere(altitudeM);
  const qbar = 0.5 * air.densityKgM3 * speedMps * speedMps;
  const mach = speedMps / air.speedOfSoundMps;
  const weight = massKg * GRAVITY_MPS2;
  const area = flight.geometry.wingAreaM2;
  const cl = (loadFactor * weight) / (qbar * area);
  const drag = qbar * area * dragFromLiftCoefficient(cl, mach, flight.aero);
  const thrust = thrustAtPower(afterburner ? 2 : 1, altitudeM, mach, flight.engine);
  return (speedMps * (thrust - drag)) / weight;
}

export { alphaForLiftCoefficient };

export function sustainedLoadFactor(
  altitudeM: number,
  speedMps: number,
  massKg: number,
  flight: FlightSpec = F16_FLIGHT,
): number {
  const ceiling = availableLoadFactor(altitudeM, speedMps, massKg, flight);
  if (specificExcessPower(altitudeM, speedMps, 1, massKg, true, flight) < 0) return 0;
  let low = 1;
  let high = ceiling;
  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    if (specificExcessPower(altitudeM, speedMps, mid, massKg, true, flight) > 0) low = mid;
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

export function bestSustainedTurn(altitudeM: number, massKg: number, flight: FlightSpec = F16_FLIGHT): TurnPoint {
  const best = scanSpeeds(altitudeM, (speed) =>
    turnRate(sustainedLoadFactor(altitudeM, speed, massKg, flight), speed),
  );
  const loadFactor = sustainedLoadFactor(altitudeM, best.speedMps, massKg, flight);
  return {
    speedMps: best.speedMps,
    loadFactor,
    turnRateDegS: degrees(best.value),
    turnRadiusM: best.speedMps / Math.max(best.value, 1e-6),
  };
}

export function cornerSpeed(altitudeM: number, massKg: number, flight: FlightSpec = F16_FLIGHT): TurnPoint {
  const best = scanSpeeds(altitudeM, (speed) =>
    turnRate(availableLoadFactor(altitudeM, speed, massKg, flight), speed),
  );
  const loadFactor = availableLoadFactor(altitudeM, best.speedMps, massKg, flight);
  return {
    speedMps: best.speedMps,
    loadFactor,
    turnRateDegS: degrees(best.value),
    turnRadiusM: best.speedMps / Math.max(best.value, 1e-6),
  };
}

/** The mass it fights at: empty, plus the fuel it starts a match with. */
export function combatMass(flight: FlightSpec = F16_FLIGHT): number {
  return flight.mass.emptyKg + flight.mass.internalFuelKg * flight.mass.startFuelFraction;
}

export function maximumLevelSpeed(altitudeM: number, flight: FlightSpec = F16_FLIGHT): number {
  const air = atmosphere(altitudeM);
  const mass = flight === F16_FLIGHT ? 11_105 : combatMass(flight);
  let fastest = 0;
  for (let speed = 100; speed <= 2.3 * air.speedOfSoundMps; speed += 1) {
    if (specificExcessPower(altitudeM, speed, 1, mass, true, flight) > 0) fastest = speed;
  }
  return fastest;
}

export function stallSpeed(altitudeM: number, massKg: number, flight: FlightSpec = F16_FLIGHT): number {
  const air = atmosphere(altitudeM);
  return Math.sqrt(
    (2 * massKg * GRAVITY_MPS2) / (air.densityKgM3 * flight.geometry.wingAreaM2 * limiterCl(flight)),
  );
}
