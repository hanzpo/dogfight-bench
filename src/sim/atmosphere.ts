/**
 * 1976 U.S. Standard Atmosphere, troposphere plus lower stratosphere.
 *
 * Dogfights in this benchmark stay below 20 km, so the two-layer model is
 * exact enough and avoids the exponential approximation's ~8% density error
 * around the tropopause.
 */

export const SEA_LEVEL_DENSITY = 1.225;
export const SEA_LEVEL_PRESSURE = 101_325;
export const SEA_LEVEL_TEMPERATURE = 288.15;
export const GRAVITY_MPS2 = 9.80665;

const LAPSE_RATE = 0.0065;
const GAS_CONSTANT = 287.05287;
const GAMMA = 1.4;
const TROPOPAUSE_ALT = 11_000;
const TROPOPAUSE_TEMP = SEA_LEVEL_TEMPERATURE - LAPSE_RATE * TROPOPAUSE_ALT;
const TROPOPAUSE_PRESSURE =
  SEA_LEVEL_PRESSURE * (TROPOPAUSE_TEMP / SEA_LEVEL_TEMPERATURE) ** (GRAVITY_MPS2 / (LAPSE_RATE * GAS_CONSTANT));

export interface AtmosphereSample {
  temperatureK: number;
  pressurePa: number;
  densityKgM3: number;
  speedOfSoundMps: number;
}

export function atmosphere(altitudeM: number): AtmosphereSample {
  const h = Math.max(altitudeM, 0);
  let temperatureK: number;
  let pressurePa: number;
  if (h <= TROPOPAUSE_ALT) {
    temperatureK = SEA_LEVEL_TEMPERATURE - LAPSE_RATE * h;
    pressurePa =
      SEA_LEVEL_PRESSURE * (temperatureK / SEA_LEVEL_TEMPERATURE) ** (GRAVITY_MPS2 / (LAPSE_RATE * GAS_CONSTANT));
  } else {
    temperatureK = TROPOPAUSE_TEMP;
    pressurePa =
      TROPOPAUSE_PRESSURE * Math.exp((-GRAVITY_MPS2 * (h - TROPOPAUSE_ALT)) / (GAS_CONSTANT * TROPOPAUSE_TEMP));
  }
  const densityKgM3 = pressurePa / (GAS_CONSTANT * temperatureK);
  return {
    temperatureK,
    pressurePa,
    densityKgM3,
    speedOfSoundMps: Math.sqrt(GAMMA * GAS_CONSTANT * temperatureK),
  };
}

export function airDensity(altitudeM: number): number {
  return atmosphere(altitudeM).densityKgM3;
}

export function speedOfSound(altitudeM: number): number {
  return atmosphere(altitudeM).speedOfSoundMps;
}

/** Density ratio against sea level; drives thrust lapse and equivalent airspeed. */
export function densityRatio(altitudeM: number): number {
  return airDensity(altitudeM) / SEA_LEVEL_DENSITY;
}

/** Calibrated airspeed is what a pilot flies and what the FLCS gain-schedules on. */
export function equivalentAirspeed(trueAirspeedMps: number, altitudeM: number): number {
  return trueAirspeedMps * Math.sqrt(densityRatio(altitudeM));
}
