import { AERO, GEOMETRY, type AeroSpec } from "./config";

export interface AeroCoefficients {
  cl: number;
  cd: number;
  cy: number;
  stalled: boolean;
}

export function liftCoefficient(alphaRad: number, aero: AeroSpec = AERO): number {
  const sign = alphaRad < 0 ? -1 : 1;
  const alpha = Math.abs(alphaRad);
  const peak = aero.clMaxAlphaRad;
  if (alpha <= peak) {
    const linear = aero.clAlpha * alpha;
    const shaped = aero.clMax * Math.sin((Math.PI / 2) * (alpha / peak));
    const blend = Math.min(1, alpha / peak);
    return sign * (aero.clZero * (1 - blend) + linear * (1 - blend) + shaped * blend);
  }
  const past = alpha - peak;
  const decayed = aero.clMax - (aero.clMax - aero.clStallFloor) * Math.min(1, past / 0.55);
  return sign * decayed;
}

export function alphaForLiftCoefficient(cl: number, aero: AeroSpec = AERO): number {
  let low = -aero.clMaxAlphaRad;
  let high = aero.clMaxAlphaRad;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (liftCoefficient(mid, aero) < cl) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function waveDrag(mach: number, aero: AeroSpec = AERO): number {
  if (mach <= aero.waveDragOnsetMach) return 0;
  if (mach <= aero.waveDragPeakMach) {
    const t = (mach - aero.waveDragOnsetMach) / (aero.waveDragPeakMach - aero.waveDragOnsetMach);
    return aero.waveDragPeak * t * t * (3 - 2 * t);
  }
  const decay = Math.exp(-(mach - aero.waveDragPeakMach) / 0.9);
  return aero.waveDragSupersonicFloor + (aero.waveDragPeak - aero.waveDragSupersonicFloor) * decay;
}

export function inducedFactor(mach: number, aero: AeroSpec = AERO): number {
  if (mach <= 0.9) return aero.inducedK;
  return aero.inducedK * (1 + 1.9 * Math.min(mach - 0.9, 0.8));
}

export interface GroundEffect {
  liftFactor: number;
  inducedFactor: number;
}

export function groundEffect(heightAboveGroundM: number, spanM: number = GEOMETRY.wingSpanM): GroundEffect {
  const ratio = Math.max(heightAboveGroundM, 0) / spanM;
  if (ratio >= 1) return { liftFactor: 1, inducedFactor: 1 };
  const proximity = (1 - ratio) ** 2;
  return { liftFactor: 1 + 0.08 * proximity, inducedFactor: 1 - 0.30 * proximity };
}

export function dragFromLiftCoefficient(cl: number, mach: number, aero: AeroSpec = AERO): number {
  const stallExcess = Math.max(0, Math.abs(cl) - aero.clMax);
  return aero.cd0 + waveDrag(mach, aero) + inducedFactor(mach, aero) * cl * cl + aero.cdSeparation * stallExcess;
}

export function coefficients(
  alphaRad: number,
  betaRad: number,
  mach: number,
  heightAboveGroundM: number,
  aero: AeroSpec = AERO,
  spanM: number = GEOMETRY.wingSpanM,
): AeroCoefficients {
  const ground = groundEffect(heightAboveGroundM, spanM);
  const cl = liftCoefficient(alphaRad, aero) * ground.liftFactor;
  const stalled = Math.abs(alphaRad) > aero.clMaxAlphaRad;
  const separation = stalled ? aero.cdSeparation * (Math.abs(alphaRad) - aero.clMaxAlphaRad) ** 1.5 : 0;
  const sideslipDrag = 1.35 * betaRad * betaRad;
  const cd =
    aero.cd0 + waveDrag(mach, aero) + inducedFactor(mach, aero) * cl * cl * ground.inducedFactor + separation + sideslipDrag;
  return { cl, cd, cy: aero.cyBeta * betaRad, stalled };
}

export interface MomentCoefficients {
  roll: number;
  pitch: number;
  yaw: number;
}

export function momentCoefficients(
  alphaRad: number,
  betaRad: number,
  pHat: number,
  qHat: number,
  rHat: number,
  pitchCommand: number,
  rollCommand: number,
  yawCommand: number,
  departed: boolean,
  aero: AeroSpec = AERO,
): MomentCoefficients {
  const surfaceEffectiveness = departed ? 0.25 : 1 - 0.55 * Math.max(0, Math.abs(alphaRad) - 0.35);
  const eff = Math.max(0.2, surfaceEffectiveness);

  const cnBeta =
    Math.abs(betaRad) < aero.betaDepartureRad
      ? aero.cnBeta
      : aero.cnBeta * (1 - 2.4 * Math.min(1, (Math.abs(betaRad) - aero.betaDepartureRad) / 0.3));

  const pitch =
    aero.cmZero + aero.cmAlpha * alphaRad + aero.cmQ * qHat + aero.cmPitchCommand * pitchCommand * eff;
  const roll =
    aero.clBeta * betaRad +
    aero.clP * pHat +
    aero.clR * rHat +
    (aero.clRollCommand * rollCommand + aero.clYawCommand * yawCommand) * eff;
  const yaw =
    cnBeta * betaRad +
    aero.cnP * pHat +
    aero.cnR * rHat +
    (aero.cnYawCommand * yawCommand + aero.cnRollCommand * rollCommand) * eff;
  return { roll, pitch, yaw };
}
