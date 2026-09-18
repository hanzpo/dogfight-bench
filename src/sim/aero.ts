import { AERO, GEOMETRY } from "./config";

/**
 * Aerodynamic coefficient build-up.
 *
 * Every function here is pure and deterministic so the envelope tests can probe
 * the aerodynamics without instantiating an aircraft.
 */

export interface AeroCoefficients {
  cl: number;
  cd: number;
  cy: number;
  /** True once the wing is past CL_max. */
  stalled: boolean;
}

/**
 * Lift curve: linear to ~15 deg, rounding over to CL_max at 27 deg with the
 * leading-edge flaps scheduled, then a gradual post-stall decay rather than a
 * cliff, which is what the real jet does behind its alpha limiter.
 */
export function liftCoefficient(alphaRad: number): number {
  const sign = alphaRad < 0 ? -1 : 1;
  const alpha = Math.abs(alphaRad);
  const peak = AERO.clMaxAlphaRad;
  if (alpha <= peak) {
    // Sine blend reaches CL_max with zero slope exactly at the peak alpha.
    const linear = AERO.clAlpha * alpha;
    const shaped = AERO.clMax * Math.sin((Math.PI / 2) * (alpha / peak));
    const blend = Math.min(1, alpha / peak);
    return sign * (AERO.clZero * (1 - blend) + linear * (1 - blend) + shaped * blend);
  }
  const past = alpha - peak;
  const decayed = AERO.clMax - (AERO.clMax - AERO.clStallFloor) * Math.min(1, past / 0.55);
  return sign * decayed;
}

/** Inverts the lift curve below the stall; monotonic there, so bisection is exact enough. */
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

/** Compressibility drag rise, added to the clean zero-lift drag. */
export function waveDrag(mach: number): number {
  if (mach <= AERO.waveDragOnsetMach) return 0;
  if (mach <= AERO.waveDragPeakMach) {
    const t = (mach - AERO.waveDragOnsetMach) / (AERO.waveDragPeakMach - AERO.waveDragOnsetMach);
    return AERO.waveDragPeak * t * t * (3 - 2 * t);
  }
  const decay = Math.exp(-(mach - AERO.waveDragPeakMach) / 0.9);
  return AERO.waveDragSupersonicFloor + (AERO.waveDragPeak - AERO.waveDragSupersonicFloor) * decay;
}

/**
 * Induced drag factor. Above the critical Mach the effective aspect ratio drops,
 * so a supersonic turn costs far more energy than the same turn at M 0.8.
 */
export function inducedFactor(mach: number): number {
  if (mach <= 0.9) return AERO.inducedK;
  return AERO.inducedK * (1 + 1.9 * Math.min(mach - 0.9, 0.8));
}

/**
 * Ground effect. Inside roughly one wingspan of the surface the trailing
 * vortices are suppressed: lift rises slightly and induced drag falls. The real
 * effect is modest, so the numbers stay modest -- it should matter in a
 * deck-level scissors and nowhere else.
 */
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

/** Drag polar evaluated straight from a lift coefficient, for performance queries. */
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
  // Sideslip drags hard; this is what punishes uncoordinated gun-tracking.
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

/**
 * Non-dimensional moment coefficients in body axes.
 *
 * `pHat`/`qHat`/`rHat` are the usual normalised body rates; surface deflections
 * are normalised to their mechanical limits.
 */
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
  // Control power fades as the surfaces stall out behind a separated wing.
  const surfaceEffectiveness = departed ? 0.25 : 1 - 0.55 * Math.max(0, Math.abs(alphaRad) - 0.35);
  const eff = Math.max(0.2, surfaceEffectiveness);

  // Directional stability reverses past the departure sideslip: this is the
  // source of the nose slice, rather than an arbitrary "you departed" flag.
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
