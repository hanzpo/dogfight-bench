import { radians } from "../math";

export const GEOMETRY = {
  wingAreaM2: 27.87,
  wingSpanM: 9.96,
  meanChordM: 3.45,
  lengthM: 15.03,
  aspectRatio: (9.96 * 9.96) / 27.87,
} as const;

export const NOZZLE = {
  exitZM: -7.21,
  centreYM: -0.087,
  exitRadiusM: 0.47,
} as const;

export const MASS = {
  emptyKg: 9_200,
  internalFuelKg: 3_175,
  startFuelFraction: 0.6,
  ixxKgM2: 9_496,
  iyyKgM2: 55_814,
  izzKgM2: 63_100,
  ixzKgM2: 982,
  fuelInertiaFraction: 0.22,
} as const;

export const ENGINE = {
  militaryThrustSlN: 76_300,
  afterburnerThrustSlN: 129_000,
  afterburnerThreshold: 0.85,
  spoolUpTau: 0.9,
  spoolDownTau: 1.4,
  afterburnerTau: 0.55,
  tsfcMilitary: 1.9e-5,
  tsfcAfterburner: 5.4e-5,
  idleFraction: 0.06,
  installationEfficiency: 0.95,
} as const;

export const AERO = {
  clAlpha: 4.35,
  clZero: 0.09,
  clMaxAlphaRad: radians(27),
  clMax: 1.95,
  clStallFloor: 0.42,
  cd0: 0.0215,
  inducedK: 0.1235,
  cdSeparation: 0.85,
  waveDragOnsetMach: 0.86,
  waveDragPeakMach: 1.08,
  waveDragPeak: 0.0345,
  waveDragSupersonicFloor: 0.0205,
  cyBeta: -1.05,
  cmZero: 0.02,
  cmAlpha: -0.34,
  cmQ: -5.2,
  clBeta: -0.105,
  clP: -0.31,
  clR: 0.075,
  cnBeta: 0.125,
  cnP: -0.028,
  cnR: -0.36,
  cmPitchCommand: 1.22,
  clRollCommand: 0.112,
  clYawCommand: 0.014,
  cnYawCommand: 0.078,
  cnRollCommand: -0.012,
  betaDepartureRad: radians(22),
  alphaDepartureRad: radians(32),
} as const;

export const SURFACES = {
  elevatorMaxRad: radians(25),
  aileronMaxRad: radians(21.5),
  rudderMaxRad: radians(30),
  elevatorRateRadS: radians(60),
  aileronRateRadS: radians(80),
  rudderRateRadS: radians(120),
} as const;

export const FLCS = {
  maxLoadFactor: 9.0,
  minLoadFactor: -3.0,
  alphaLimitRad: radians(25),
  maxRollRateRadS: radians(308),
  rollAlphaFadeStartRad: radians(15),
  pitchRateGain: 0.28,
  pitchRateDamping: 0.06,
  alphaTrackingGain: 3.6,
  alphaIntegralGain: 0.55,
  alphaIntegralLimitRad: radians(4),
  negativeAlphaLimitFraction: 0.5,
  rollRateGain: 0.16,
  yawDamperGain: 0.85,
  sideslipGain: 2.5,
  maxCommandedSideslipRad: radians(12),
  minGainScheduleQ: 1_500,
  referenceQ: 22_000,
} as const;

export const GUN = {
  ammunition: 511,
  ratePerSecond: 100,
  muzzleVelocityMps: 1_036,
  projectileMassKg: 0.1021,
  projectileDiameterM: 0.020,
  ballisticCoefficientG1: 0.46,
  dispersionRad1Sigma: 0.0020,
  spinUpSeconds: 0.22,
  spinDownSeconds: 1.6,
  initialRateFraction: 0.35,
  maxLifeSeconds: 6.0,
  boresightElevationRad: 0,
  muzzleOffsetM: [-0.58, 0.82, 2.7] as const,
  burstLimit: 100,
} as const;

export const MIN_LETHAL_ENERGY_J = 3_000;

export const EARTH_RADIUS_M = 6_371_000;

export const F16 = {
  massKg: MASS.emptyKg + MASS.internalFuelKg * MASS.startFuelFraction,
  wingAreaM2: GEOMETRY.wingAreaM2,
  maxThrustN: ENGINE.militaryThrustSlN,
  afterburnerThrustN: ENGINE.afterburnerThrustSlN,
  maxAoARad: FLCS.alphaLimitRad,
  gun: GUN,
} as const;
