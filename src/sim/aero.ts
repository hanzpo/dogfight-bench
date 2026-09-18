import { AERO, GEOMETRY } from "./config";

export interface AeroCoefficients {
  cl: number;
  cd: number;
  cy: number;
  stalled: boolean;
}

export function liftCoefficient(alphaRad: number): number {
  const sign = alphaRad < 0 ? -1 : 1;
  const alpha = Math.abs(alphaRad);
  const peak = AERO.clMaxAlphaRad;
  if (alpha <= peak) {
    const linear = AERO.clAlpha * alpha;
    const shaped = AERO.clMax * Math.sin((Math.PI / 2) * (alpha / peak));
    const blend = Math.min(1, alpha / peak);
    return sign * (AERO.clZero * (1 - blend) + linear * (1 - blend) + shaped * blend);
  }
  const past = alpha - peak;
  const decayed = AERO.clMax - (AERO.clMax - AERO.clStallFloor) * Math.min(1, past / 0.55);
  return sign * decayed;
}

export function alphaForLiftCoefficient(cl: number): number {
  let low = -AERO.clMaxAlphaRad;
  let high = AERO.clMaxAlphaRad;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (liftCoefficient(mid) < cl) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function waveDrag(mach: number): number {
  if (mach <= AERO.waveDragOnsetMach) return 0;
  if (mach <= AERO.waveDragPeakMach) {
    const t = (mach - AERO.waveDragOnsetMach) / (AERO.waveDragPeakMach - AERO.waveDragOnsetMach);
    return AERO.waveDragPeak * t * t * (3 - 2 * t);
  }
  const decay = Math.exp(-(mach - AERO.waveDragPeakMach) / 0.9);
  return AERO.waveDragSupersonicFloor + (AERO.waveDragPeak - AERO.waveDragSupersonicFloor) * decay;
}

export function inducedFactor(mach: number): number {
  if (mach <= 0.9) return AERO.inducedK;
  return AERO.inducedK * (1 + 1.9 * Math.min(mach - 0.9, 0.8));
}

export interface GroundEffect {
  liftFactor: number;
  inducedFactor: number;
}

export function groundEffect(heightAboveGroundM: number): GroundEffect {
  const ratio = Math.max(heightAboveGroundM, 0) / GEOMETRY.wingSpanM;
  if (ratio >= 1) return { liftFactor: 1, inducedFactor: 1 };
  const proximity = (1 - ratio) ** 2;
  return { liftFactor: 1 + 0.08 * proximity, inducedFactor: 1 - 0.30 * proximity };
}

export function dragFromLiftCoefficient(cl: number, mach: number): number {
  const stallExcess = Math.max(0, Math.abs(cl) - AERO.clMax);
  return AERO.cd0 + waveDrag(mach) + inducedFactor(mach) * cl * cl + AERO.cdSeparation * stallExcess;
}

export function coefficients(
  alphaRad: number,
  betaRad: number,
  mach: number,
  heightAboveGroundM: number,
): AeroCoefficients {
  const ground = groundEffect(heightAboveGroundM);
  const cl = liftCoefficient(alphaRad) * ground.liftFactor;
  const stalled = Math.abs(alphaRad) > AERO.clMaxAlphaRad;
  const separation = stalled ? AERO.cdSeparation * (Math.abs(alphaRad) - AERO.clMaxAlphaRad) ** 1.5 : 0;
  const sideslipDrag = 1.35 * betaRad * betaRad;
  const cd =
    AERO.cd0 + waveDrag(mach) + inducedFactor(mach) * cl * cl * ground.inducedFactor + separation + sideslipDrag;
  return { cl, cd, cy: AERO.cyBeta * betaRad, stalled };
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
): MomentCoefficients {
  const surfaceEffectiveness = departed ? 0.25 : 1 - 0.55 * Math.max(0, Math.abs(alphaRad) - 0.35);
  const eff = Math.max(0.2, surfaceEffectiveness);

  const cnBeta =
    Math.abs(betaRad) < AERO.betaDepartureRad
      ? AERO.cnBeta
      : AERO.cnBeta * (1 - 2.4 * Math.min(1, (Math.abs(betaRad) - AERO.betaDepartureRad) / 0.3));

  const pitch =
    AERO.cmZero + AERO.cmAlpha * alphaRad + AERO.cmQ * qHat + AERO.cmPitchCommand * pitchCommand * eff;
  const roll =
    AERO.clBeta * betaRad +
    AERO.clP * pHat +
    AERO.clR * rHat +
    (AERO.clRollCommand * rollCommand + AERO.clYawCommand * yawCommand) * eff;
  const yaw =
    cnBeta * betaRad +
    AERO.cnP * pHat +
    AERO.cnR * rHat +
    (AERO.cnYawCommand * yawCommand + AERO.cnRollCommand * rollCommand) * eff;
  return { roll, pitch, yaw };
}
