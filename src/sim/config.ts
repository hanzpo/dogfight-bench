/**
 * F-16C (Block 50, F110-GE-129) reference data.
 *
 * Geometry, mass properties and the stability-derivative set follow the public
 * NASA/Stevens & Lewis F-16 model. Aerodynamic coefficients here are a smooth
 * analytic fit rather than the original lookup tables: the goal is an honest
 * energy-manoeuvrability envelope (see `test/flight-envelope.test.ts`), not a
 * certified simulation.
 */

export const GEOMETRY = {
  wingAreaM2: 27.87,
  wingSpanM: 9.96,
  meanChordM: 3.45,
  lengthM: 15.03,
  /** Aspect ratio b^2 / S. */
  aspectRatio: (9.96 * 9.96) / 27.87,
} as const;

export const MASS = {
  /** Operating empty weight plus two wingtip AIM-9 and full 20 mm load. */
  emptyKg: 9_200,
  internalFuelKg: 3_175,
  /** Fuel fraction the benchmark starts with, so both jets begin identical. */
  startFuelFraction: 0.6,
  /** Body-axis inertia tensor about the CG, kg*m^2. */
  ixxKgM2: 9_496,
  iyyKgM2: 55_814,
  izzKgM2: 63_100,
  ixzKgM2: 982,
  /** Inertia scaling between empty and full fuel. */
  fuelInertiaFraction: 0.22,
} as const;

export const ENGINE = {
  militaryThrustSlN: 76_300,
  afterburnerThrustSlN: 129_000,
  /** Throttle above this fraction commands afterburner. */
  afterburnerThreshold: 0.85,
  /** First-order spool time constants, seconds. */
  spoolUpTau: 0.9,
  spoolDownTau: 1.4,
  /** Afterburner light-off lag on top of core spool. */
  afterburnerTau: 0.55,
  /** Thrust-specific fuel consumption, kg per newton-second. */
  tsfcMilitary: 1.9e-5,
  tsfcAfterburner: 5.4e-5,
  /** Idle thrust as a fraction of military. */
  idleFraction: 0.06,
  /**
   * Installed-versus-uninstalled thrust. Published static thrust is measured on
   * a test stand; inlet and nozzle losses cost a few percent on the airframe.
   */
  installationEfficiency: 0.95,
} as const;

export const AERO = {
  /** Lift-curve slope, per radian, before high-alpha rounding. */
  clAlpha: 4.35,
  clZero: 0.09,
  /** Alpha at which CL peaks with leading-edge flaps scheduled, radians. */
  clMaxAlphaRad: (27 * Math.PI) / 180,
  clMax: 1.95,
  /** Post-stall lift retention floor. */
  clStallFloor: 0.42,
  /** Zero-lift drag, clean, subsonic. */
  cd0: 0.0215,
  /** Induced drag factor including trim and non-elliptic loading. */
  inducedK: 0.1235,
  /** Extra drag once the wing is past CL_max. */
  cdSeparation: 0.85,
  /** Transonic wave drag: rise start, peak Mach, peak increment. */
  waveDragOnsetMach: 0.86,
  waveDragPeakMach: 1.08,
  waveDragPeak: 0.0345,
  waveDragSupersonicFloor: 0.0205,
  /** Side-force derivative per radian of sideslip. */
  cyBeta: -1.05,
  /** Longitudinal derivatives (moment positive = nose up). */
  cmZero: 0.02,
  cmAlpha: -0.34,
  cmQ: -5.2,
  /** Lateral/directional derivatives (roll positive = right wing down, yaw positive = nose right). */
  clBeta: -0.105,
  clP: -0.31,
  clR: 0.075,
  cnBeta: 0.125,
  cnP: -0.028,
  cnR: -0.36,
  /**
   * Control effectiveness is expressed against normalised *command* axes rather
   * than surface deflections, so every sign below reads the same way as the
   * pilot's stick: +1 pitch = nose up, +1 roll = right wing down, +1 yaw = nose
   * right. Magnitudes are the usual delta-e / delta-a / delta-r derivatives.
   */
  cmPitchCommand: 1.22,
  clRollCommand: 0.112,
  clYawCommand: 0.014,
  cnYawCommand: 0.078,
  cnRollCommand: -0.012,
  /** Sideslip beyond which directional stability collapses, radians. */
  betaDepartureRad: (22 * Math.PI) / 180,
  /** Alpha beyond which the jet can depart controlled flight, radians. */
  alphaDepartureRad: (32 * Math.PI) / 180,
} as const;

export const SURFACES = {
  elevatorMaxRad: (25 * Math.PI) / 180,
  aileronMaxRad: (21.5 * Math.PI) / 180,
  rudderMaxRad: (30 * Math.PI) / 180,
  /** Actuator rate limits, rad/s. */
  elevatorRateRadS: (60 * Math.PI) / 180,
  aileronRateRadS: (80 * Math.PI) / 180,
  rudderRateRadS: (120 * Math.PI) / 180,
} as const;

export const FLCS = {
  /** Structural limits the flight-control laws enforce. */
  maxLoadFactor: 9.0,
  minLoadFactor: -3.0,
  /** Angle-of-attack limiter, radians. */
  alphaLimitRad: (25 * Math.PI) / 180,
  /** Commanded roll rate at full lateral stick, rad/s. */
  maxRollRateRadS: (308 * Math.PI) / 180,
  /** Roll authority is faded out as the limiter engages. */
  rollAlphaFadeStartRad: (15 * Math.PI) / 180,
  /**
   * Inner rate-loop gains. Full command deflection is worth roughly 55 rad/s^2
   * in pitch and 86 rad/s^2 in roll, so these are sized for a ~12 rad/s
   * crossover -- comfortably inside the actuators' 60-80 deg/s travel rate.
   * Larger values look responsive on paper and ring the airframe apart.
   */
  pitchRateGain: 0.28,
  pitchRateDamping: 0.06,
  /**
   * The longitudinal outer loop converts commanded g into a commanded angle of
   * attack and tracks that. Going through alpha rather than straight to a pitch
   * rate is what makes the limiter inherent: the command is clamped before it
   * ever reaches the airframe, so the jet cannot be asked for a rate it has no
   * lift to produce.
   */
  alphaTrackingGain: 3.6,
  alphaIntegralGain: 0.55,
  alphaIntegralLimitRad: (4 * Math.PI) / 180,
  /** Negative-g alpha limit as a fraction of the positive limit. */
  negativeAlphaLimitFraction: 0.5,
  rollRateGain: 0.16,
  yawDamperGain: 0.85,
  sideslipGain: 2.5,
  /** Sideslip commanded by full pedal, radians. */
  maxCommandedSideslipRad: (12 * Math.PI) / 180,
  /** Gain schedule floor at low dynamic pressure. */
  minGainScheduleQ: 1_500,
  referenceQ: 22_000,
} as const;

export const GUN = {
  /** M61A1 Vulcan, 20x102 mm, PGU-28/B. */
  ammunition: 511,
  ratePerSecond: 100,
  muzzleVelocityMps: 1_036,
  projectileMassKg: 0.1021,
  projectileDiameterM: 0.020,
  /** Form factor for the G1 standard drag curve. */
  ballisticCoefficientG1: 0.46,
  /** Barrel-cluster dispersion, 1-sigma, radians (8 mil 80% circle). */
  dispersionRad1Sigma: 0.0020,
  /**
   * Rotor spin-up, seconds.
   *
   * The rate of fire ramps with the rotor rather than the gun sitting dead
   * until it is up to speed, which is both how a rotary cannon actually
   * behaves and the difference between a trigger that responds and one that
   * feels broken. First rounds are out within a few hundredths of a second.
   */
  spinUpSeconds: 0.22,
  /**
   * How long the rotor keeps turning after the trigger is released. Without
   * this, tapping the trigger for short bursts never fires anything at all,
   * because the rotor decays as fast as it spun up.
   */
  spinDownSeconds: 1.6,
  /** Rate fraction the rotor produces the instant the trigger goes down. */
  initialRateFraction: 0.35,
  maxLifeSeconds: 6.0,
  /**
   * Gun boresight elevation relative to the fuselage reference line. The M61 is
   * installed essentially parallel to it, so this is zero: the lead a pilot has
   * to pull comes from angle of attack and time of flight, not from a built-in
   * bias, which keeps the geometry something an agent can reason about.
   */
  boresightElevationRad: 0,
  /** Muzzle offset in body axes (right, up, forward) from the CG, metres. */
  muzzleOffsetM: [-0.62, 0.48, 3.1] as const,
  /** Rounds that overheat the barrel; affects nothing but is reported. */
  burstLimit: 100,
} as const;

/** Kinetic energy a 20 mm round must retain to count as a damaging hit, joules. */
export const MIN_LETHAL_ENERGY_J = 3_000;

export const EARTH_RADIUS_M = 6_371_000;

/** Backwards-compatible aggregate used by older call sites. */
export const F16 = {
  massKg: MASS.emptyKg + MASS.internalFuelKg * MASS.startFuelFraction,
  wingAreaM2: GEOMETRY.wingAreaM2,
  maxThrustN: ENGINE.militaryThrustSlN,
  afterburnerThrustN: ENGINE.afterburnerThrustSlN,
  maxAoARad: FLCS.alphaLimitRad,
  gun: GUN,
} as const;
