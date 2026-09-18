import { coefficients, liftCoefficient } from "./aero";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { ENGINE, GEOMETRY } from "./config";
import { commandedPower, thrustAtPower } from "./engine";
import { heightAboveGround } from "./terrain";

export interface TrimSolution {
  alphaRad: number;
  throttle: number;
  feasible: boolean;
  thrustRequiredN: number;
  thrustAvailableN: number;
}

export function trimLevelFlight(altitudeM: number, speedMps: number, massKg: number): TrimSolution {
  const air = atmosphere(altitudeM);
  const qbar = 0.5 * air.densityKgM3 * speedMps * speedMps;
  const mach = speedMps / air.speedOfSoundMps;
  const weight = massKg * GRAVITY_MPS2;
  const clRequired = weight / (qbar * GEOMETRY.wingAreaM2);

  let low = -0.2;
  let high = 0.47;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (liftCoefficient(mid) < clRequired) low = mid;
    else high = mid;
  }
  const alphaRad = (low + high) / 2;

  const agl = heightAboveGround(0, altitudeM, 0);
  const { cd } = coefficients(alphaRad, 0, mach, agl);
  const thrustRequiredN = qbar * GEOMETRY.wingAreaM2 * cd;
  const thrustAvailableN = thrustAtPower(2, altitudeM, mach);

  let lowPower = 0;
  let highPower = 2;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lowPower + highPower) / 2;
    if (thrustAtPower(mid, altitudeM, mach) < thrustRequiredN) lowPower = mid;
    else highPower = mid;
  }
  const power = (lowPower + highPower) / 2;
  const throttle =
    power <= 1 ? power * ENGINE.afterburnerThreshold : ENGINE.afterburnerThreshold + (power - 1) * (1 - ENGINE.afterburnerThreshold);

  return {
    alphaRad,
    throttle: Math.max(0, Math.min(1, throttle)),
    feasible: clRequired <= liftCoefficient(0.47) && thrustRequiredN <= thrustAvailableN,
    thrustRequiredN,
    thrustAvailableN,
  };
}

export function trimPower(throttle: number): number {
  return commandedPower(throttle);
}
