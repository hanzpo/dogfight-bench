import {
  AERO,
  ENGINE,
  F16_CG,
  F16_FLIGHT,
  FLCS,
  GEOMETRY,
  GUN,
  MASS,
  MISSILE,
  NOZZLE,
  SURFACES,
  type AeroSpec,
  type EngineSpec,
  type FlcsSpec,
  type FlightSpec,
  type GunSpec,
  type MissileSpec,
} from "./config";
import { HIT_VOLUMES, type HitVolume } from "./damage";
import { radians } from "../math";

export const AIRFRAME_IDS = ["f16c", "mig29a", "fa18c", "f15c", "su27s", "m2000c", "f5e", "jas39c"] as const;
export type AirframeId = (typeof AIRFRAME_IDS)[number];

/** Body axes, metres: right, up, nose. The model's origin is the middle of its length. */
export type BodyPoint = readonly [number, number, number];

/** What the stand-in model is built from until a real one is dropped in. */
export interface PlaceholderShape {
  fuselageRadiusM: number;
  wing: "trapezoid" | "delta";
  /** Leading-edge root, back from the nose, as a fraction of length. */
  wingRootAt: number;
  wingRootChordM: number;
  wingTipChordM: number;
  wingSweepDeg: number;
  tailplane: boolean;
  fins: 1 | 2;
  finCantDeg: number;
  finHeightM: number;
  canards: boolean;
}

export interface Airframe extends FlightSpec {
  id: AirframeId;
  name: string;
  /** The kind of fight it wins, in two or three words. */
  role: string;
  gun: GunSpec;
  missile: MissileId;
  /** Heat against an F-16 at the same power: engine count, size and how hot they run. */
  infrared: number;
  nozzles: readonly BodyPoint[];
  nozzleRadiusM: number;
  /** Launch rails in the order they are fired. */
  rails: readonly BodyPoint[];
  /** A pylon this tall rises from each missile's back to the wing, for rails that hang under it. */
  pylonHeightM?: number;
  cockpitEye: BodyPoint;
  /**
   * Centre of gravity on the model. Nozzles, rails, the cockpit eye, the gun
   * muzzle and hit volumes are all given on the model, as measured off it;
   * `fromModel` turns them into positions from the centre of gravity, which
   * is the point the simulation moves and turns about.
   */
  cg: BodyPoint;
  /** Hit volumes placed on the model; the F-16's, stretched, when not given. */
  hitVolumes?: readonly HitVolume[];
  /** A real model at this path replaces the placeholder: nose along +z, up +y, metres, origin mid-length. */
  model?: string;
  /** Turns a model that was exported facing another way, so its source file need not change. */
  modelYawDeg?: number;
  placeholder: PlaceholderShape;
}

// ---------------------------------------------------------------- guns

export const GUNS = {
  m61: GUN,
  gsh301: {
    ...GUN,
    name: "GSh-30-1",
    damageScale: 2.3,
    ammunition: 150,
    ratePerSecond: 25,
    muzzleVelocityMps: 860,
    projectileMassKg: 0.39,
    projectileDiameterM: 0.03,
    ballisticCoefficientG1: 0.62,
    dispersionRad1Sigma: 0.0024,
    // A single barrel fires at full rate at once; there is nothing to spin up.
    spinUpSeconds: 0.03,
    initialRateFraction: 1,
    muzzleOffsetM: [0.9, 0.35, 3.6] as const,
  },
  defa554: {
    ...GUN,
    name: "2× DEFA 554",
    damageScale: 1.9,
    ammunition: 250,
    ratePerSecond: 36,
    muzzleVelocityMps: 815,
    projectileMassKg: 0.24,
    projectileDiameterM: 0.03,
    ballisticCoefficientG1: 0.5,
    dispersionRad1Sigma: 0.0026,
    spinUpSeconds: 0.03,
    initialRateFraction: 1,
    muzzleOffsetM: [0, -0.5, 2.5] as const,
  },
  m39: {
    ...GUN,
    name: "2× M39A2",
    damageScale: 1,
    ammunition: 560,
    ratePerSecond: 50,
    muzzleVelocityMps: 1_030,
    dispersionRad1Sigma: 0.0024,
    spinUpSeconds: 0.03,
    initialRateFraction: 1,
    muzzleOffsetM: [0, 0.3, 5.5] as const,
  },
  bk27: {
    ...GUN,
    name: "BK-27",
    damageScale: 1.7,
    ammunition: 120,
    ratePerSecond: 28,
    muzzleVelocityMps: 1_025,
    projectileMassKg: 0.26,
    projectileDiameterM: 0.027,
    ballisticCoefficientG1: 0.55,
    dispersionRad1Sigma: 0.0021,
    spinUpSeconds: 0.03,
    initialRateFraction: 1,
    muzzleOffsetM: [-0.6, -0.2, 2.8] as const,
  },
} satisfies Record<string, GunSpec>;

// ---------------------------------------------------------------- missiles

const { rails: _rails, ...AIM9M } = MISSILE;

/**
 * Every missile is held to an AIM-9M's seeker or a little either side of it,
 * so none of them hands its carrier the merge. The R-73's real sight could
 * look far off the nose from a helmet; this one cannot.
 */
export const MISSILES = {
  aim9m: AIM9M,
  aim9p: {
    ...AIM9M,
    name: "AIM-9P",
    gimbalLimitRad: radians(30),
    acquisitionConeRad: radians(4.5),
    lockRangeReferenceM: 6_500,
    flareSusceptibility: 1.3,
    thrustN: 8_000,
    rangeFactor: 0.9,
  },
  r60m: {
    ...AIM9M,
    name: "R-60M",
    launchMassKg: 44,
    propellantKg: 13,
    thrustN: 5_600,
    burnS: 4,
    referenceAreaM2: Math.PI * 0.06 * 0.06,
    normalForceMax: 20,
    structuralLimitG: 42,
    lockRangeReferenceM: 7_000,
    fuzeRadiusM: 5,
    lethalRadiusM: 8,
    flareSusceptibility: 1.2,
    rangeFactor: 0.7,
  },
  // Held to the AIM-9M outright: with a longer motor and a helmet sight it
  // made the Su-27 the best jet in any missile fight.
  r73: {
    ...AIM9M,
    name: "R-73",
  },
  magic2: {
    ...AIM9M,
    name: "Magic II",
    launchMassKg: 89,
    propellantKg: 27,
    thrustN: 8_900,
    normalForceMax: 20,
    structuralLimitG: 45,
    rangeFactor: 0.95,
  },
} satisfies Record<string, MissileSpec>;

export type MissileId = keyof typeof MISSILES;

// ---------------------------------------------------------------- airframes

/**
 * Moments of inertia from the F-16's, scaled by mass and by the square of
 * the dimension each axis turns through. Rough, and the right shape: a Su-27
 * is slow to roll because it is heavy and wide, not because of a number
 * picked for it.
 */
function scaledMass(
  emptyKg: number,
  internalFuelKg: number,
  startFuelFraction: number,
  spanM: number,
  lengthM: number,
): FlightSpec["mass"] {
  const reference = MASS.emptyKg + MASS.internalFuelKg;
  const massRatio = (emptyKg + internalFuelKg) / reference;
  const span = (spanM / GEOMETRY.wingSpanM) ** 2;
  const length = (lengthM / GEOMETRY.lengthM) ** 2;
  const both = (spanM ** 2 + lengthM ** 2) / (GEOMETRY.wingSpanM ** 2 + GEOMETRY.lengthM ** 2);
  return {
    ...MASS,
    emptyKg,
    internalFuelKg,
    startFuelFraction,
    ixxKgM2: MASS.ixxKgM2 * massRatio * span,
    iyyKgM2: MASS.iyyKgM2 * massRatio * length,
    izzKgM2: MASS.izzKgM2 * massRatio * both,
    ixzKgM2: MASS.ixzKgM2 * massRatio * length,
  };
}

function geometry(wingAreaM2: number, wingSpanM: number, lengthM: number, meanChordM: number): FlightSpec["geometry"] {
  return { wingAreaM2, wingSpanM, lengthM, meanChordM, aspectRatio: (wingSpanM * wingSpanM) / wingAreaM2 };
}

/** Induced drag from aspect ratio and a span efficiency; deltas are less efficient than swept wings. */
function inducedK(wingSpanM: number, wingAreaM2: number, efficiency: number): number {
  return 1 / (Math.PI * ((wingSpanM * wingSpanM) / wingAreaM2) * efficiency);
}

function engine(
  dryN: number,
  wetN: number,
  tsfcMilitary: number,
  tsfcAfterburner: number,
  spoolUpTau: number = ENGINE.spoolUpTau,
): EngineSpec {
  return { ...ENGINE, militaryThrustSlN: dryN, afterburnerThrustSlN: wetN, tsfcMilitary, tsfcAfterburner, spoolUpTau };
}

function aero(overrides: Partial<AeroSpec>): AeroSpec {
  return { ...AERO, ...overrides };
}

function flcs(maxLoadFactor: number, alphaLimitDeg: number, rollRateDegS: number, extra: Partial<FlcsSpec> = {}): FlcsSpec {
  return {
    ...FLCS,
    maxLoadFactor,
    alphaLimitRad: radians(alphaLimitDeg),
    rollAlphaFadeStartRad: radians(alphaLimitDeg * 0.6),
    maxRollRateRadS: radians(rollRateDegS),
    ...extra,
  };
}

function tips(spanM: number, along: number, up = -0.08): readonly BodyPoint[] {
  return [
    [-(spanM / 2 + 0.05), up, along],
    [spanM / 2 + 0.05, up, along],
  ];
}

function pylons(outM: number, along: number, up: number): readonly BodyPoint[] {
  return [
    [-outM, up, along],
    [outM, up, along],
  ];
}

const SLUG_FT2_TO_KG_M2 = 1.355_818;

/**
 * The F/A-18 High Alpha Research Vehicle's measured inertia, from NASA
 * TP-1998-208464, at its 1,111.6 slug (16,223 kg).
 */
const HORNET_HARV = {
  massKg: 1_111.6 * 14.593_9,
  ixx: 22_632 * SLUG_FT2_TO_KG_M2,
  iyy: 174_246.3 * SLUG_FT2_TO_KG_M2,
  izz: 189_336.4 * SLUG_FT2_TO_KG_M2,
  ixz: 2_131.8 * SLUG_FT2_TO_KG_M2,
};

/** Measured inertia, scaled to this airframe's weight with full fuel. */
function measuredMass(
  emptyKg: number,
  internalFuelKg: number,
  startFuelFraction: number,
  measured: typeof HORNET_HARV,
): FlightSpec["mass"] {
  const ratio = (emptyKg + internalFuelKg) / measured.massKg;
  return {
    ...MASS,
    emptyKg,
    internalFuelKg,
    startFuelFraction,
    ixxKgM2: measured.ixx * ratio,
    iyyKgM2: measured.iyy * ratio,
    izzKgM2: measured.izz * ratio,
    ixzKgM2: measured.ixz * ratio,
  };
}

/** The F-16's hit table with each volume moved onto another model: same damage, new place and size. */
function onModel(places: Record<HitVolume["subsystem"], [BodyPoint, number]>): readonly HitVolume[] {
  return HIT_VOLUMES.map((volume) => ({
    ...volume,
    offset: places[volume.subsystem][0],
    radiusM: places[volume.subsystem][1],
  }));
}

const F16C: Airframe = {
  ...F16_FLIGHT,
  id: "f16c",
  name: "F-16C",
  role: "All-rounder",
  gun: GUNS.m61,
  missile: "aim9m",
  infrared: 1,
  nozzles: [[0, NOZZLE.centreYM, NOZZLE.exitZM]],
  nozzleRadiusM: NOZZLE.exitRadiusM,
  rails: MISSILE.rails,
  cockpitEye: [0, 1.05, 3.3],
  cg: F16_CG,
  model: "/F16_Clean.glb",
  placeholder: {
    fuselageRadiusM: 0.62, wing: "trapezoid", wingRootAt: 0.45, wingRootChordM: 5.0, wingTipChordM: 1.1,
    wingSweepDeg: 40, tailplane: true, fins: 1, finCantDeg: 0, finHeightM: 2.4, canards: false,
  },
};

/** The F-16's rival: more thrust, a harder first turn, higher angle of attack; fewer, heavier rounds and a thirsty pair of engines. */
const MIG29A: Airframe = {
  id: "mig29a",
  name: "MiG-29A",
  role: "Brawler",
  geometry: geometry(38, 11.36, 17.32, 3.6),
  mass: scaledMass(11_000, 3_380, 0.6, 11.36, 17.32),
  engine: engine(98_800, 162_600, 2.2e-5, 5.9e-5, 0.8),
  aero: aero({
    clAlpha: 4.1, clMax: 2.02, clMaxAlphaRad: radians(30), clStallFloor: 0.5,
    cd0: 0.026, inducedK: inducedK(11.36, 38, 0.64), alphaDepartureRad: radians(38),
  }),
  surfaces: SURFACES,
  flcs: flcs(9, 28, 250),
  // The GSh-30-1 is in the root of the left wing-root extension.
  gun: { ...GUNS.gsh301, muzzleOffsetM: [-1.1, 0.12, 2.0] as const },
  missile: "r60m",
  infrared: 1.5,
  // Measured off the model: nozzle exits and their openings, the canopy,
  // which runs from 1.8 to 4.9 m forward with its top at 1.72 m, and the
  // wing's underside, 0.19 m below the datum 4.3 m out.
  nozzles: [[-0.88, -0.57, -7.44], [0.88, -0.57, -7.44]],
  nozzleRadiusM: 0.42,
  // Under the outer wing, on a short pylon, nose well ahead of the leading edge.
  rails: pylons(4.3, -3.2, -0.37),
  pylonHeightM: 0.12,
  cockpitEye: [0, 1.45, 3.2],
  // A quarter of the way along the mean aerodynamic chord of the wing that
  // has the MiG's published 38 m² with the model's tip and trailing edge:
  // 3.79 m long, its leading edge 0.69 m behind the origin.
  cg: [0, 0, -1.64],
  hitVolumes: onModel({
    cockpit: [[0, 1.3, 3.2], 1.2],
    "forward-fuselage": [[0, 0.3, 0.8], 1.7],
    "left-wing": [[-3.6, -0.1, -3.4], 1.95],
    "right-wing": [[3.6, -0.1, -3.4], 1.95],
    engine: [[0, -0.3, -4.9], 1.55],
    tail: [[0, 1.4, -6.3], 1.5],
  }),
  model: "/aircraft/mig29a.glb",
  placeholder: {
    fuselageRadiusM: 0.7, wing: "trapezoid", wingRootAt: 0.42, wingRootChordM: 5.6, wingTipChordM: 1.2,
    wingSweepDeg: 42, tailplane: true, fins: 2, finCantDeg: 8, finHeightM: 2.2, canards: false,
  },
};

/** Points its nose at angles nothing else can; wins slow and loses fast, because it cannot get its energy back. */
const FA18C: Airframe = {
  id: "fa18c",
  name: "F/A-18C",
  role: "Slow-speed knife fighter",
  geometry: geometry(37.16, 11.43, 17.07, 3.51),
  mass: measuredMass(10_400, 4_900, 0.55, HORNET_HARV),
  engine: engine(97_900, 158_400, 2.3e-5, 4.9e-5),
  aero: aero({
    clAlpha: 4.3, clMax: 2.12, clMaxAlphaRad: radians(36), clStallFloor: 0.7,
    cd0: 0.0235, waveDragPeak: 0.045, inducedK: inducedK(11.43, 37.16, 0.7),
    alphaDepartureRad: radians(55), betaDepartureRad: radians(26),
  }),
  surfaces: SURFACES,
  flcs: flcs(7.5, 35, 240),
  // The M61 sits on top of the nose, just behind the radome.
  gun: { ...GUNS.m61, ammunition: 578, muzzleOffsetM: [0, 0.55, 6.6] as const },
  missile: "aim9m",
  infrared: 1.4,
  // Measured off the model: nozzle exits, the wingtip rails, and a seat under
  // the canopy, which runs from 1.8 to 5.2 m forward with its top at 1.44 m.
  nozzles: [[-0.56, 0.03, -7.99], [0.56, 0.03, -7.99]],
  // The opening at the exit, not the petals' widest point upstream of it.
  nozzleRadiusM: 0.33,
  // On the outboard face of each tip rail, level with it: the rail runs 5.68
  // to 5.86 m out, so the missile's axis sits its own radius and a hair beyond
  // that, with its nose well ahead of the wing's leading edge.
  rails: [
    [-5.935, -0.055, -2.2],
    [5.935, -0.055, -2.2],
  ],
  cockpitEye: [0, 1.2, 4.0],
  // A quarter of the way back along its mean aerodynamic chord, which the
  // model's wing puts 3.29 m long with its leading edge 0.49 m behind the
  // origin -- and the 37 m² it measures is the real Hornet's wing area.
  cg: [0, 0, -1.31],
  hitVolumes: onModel({
    cockpit: [[0, 1.0, 3.5], 1.05],
    "forward-fuselage": [[0, 0.2, 1.2], 1.6],
    "left-wing": [[-3.6, 0.05, -2.7], 1.9],
    "right-wing": [[3.6, 0.05, -2.7], 1.9],
    engine: [[0, 0, -5.3], 1.6],
    tail: [[0, 1.7, -6.6], 1.6],
  }),
  model: "/aircraft/fa18c.glb",
  // Exported nose-aft, along -z.
  modelYawDeg: 180,
  placeholder: {
    fuselageRadiusM: 0.68, wing: "trapezoid", wingRootAt: 0.43, wingRootChordM: 4.8, wingTipChordM: 1.7,
    wingSweepDeg: 26, tailplane: true, fins: 2, finCantDeg: 20, finHeightM: 2.3, canards: false,
  },
};

/** The energy fighter: the most thrust and the biggest wing, wins going up; a big, hot target that is slow to roll. */
const F15C: Airframe = {
  id: "f15c",
  name: "F-15C",
  role: "Energy fighter",
  geometry: geometry(56.5, 13.05, 19.43, 4.86),
  mass: scaledMass(12_700, 6_100, 0.5, 13.05, 19.43),
  engine: engine(125_000, 202_000, 2.1e-5, 5.5e-5),
  aero: aero({
    clAlpha: 4.2, clMax: 1.55, clMaxAlphaRad: radians(28), cd0: 0.0185,
    inducedK: inducedK(13.05, 56.5, 0.64), alphaDepartureRad: radians(34),
  }),
  surfaces: SURFACES,
  flcs: flcs(9, 27, 205),
  // The M61 is in the root of the right wing, above the intake.
  gun: { ...GUNS.m61, ammunition: 940, muzzleOffsetM: [1.75, 0.1, 0.9] as const },
  missile: "aim9m",
  infrared: 2,
  // Measured off the model: nozzle exits and their openings, the canopy,
  // which runs from 2.4 to 6.4 m forward with its top at 1.05 m, and the
  // wing's underside, 0.1 m below the datum 3.8 m out.
  nozzles: [[-0.7, -0.58, -8.515], [0.7, -0.58, -8.515]],
  nozzleRadiusM: 0.5,
  // Under the wing on its pylon, nose ahead of the leading edge.
  rails: pylons(3.8, -2.0, -0.28),
  pylonHeightM: 0.12,
  cockpitEye: [0, 0.75, 4.7],
  // A quarter of the way along the mean aerodynamic chord of the wing that
  // has the Eagle's published 56.5 m² with the model's tip and trailing
  // edge: 4.79 m long, its leading edge 1.0 m behind the origin.
  cg: [0, 0, -2.2],
  hitVolumes: onModel({
    cockpit: [[0, 0.55, 4.6], 1.35],
    "forward-fuselage": [[0, 0, 1.5], 1.95],
    "left-wing": [[-4.2, -0.1, -3.2], 2.2],
    "right-wing": [[4.2, -0.1, -3.2], 2.2],
    engine: [[0, -0.4, -5.8], 1.75],
    tail: [[0, 1.6, -7.8], 1.7],
  }),
  model: "/aircraft/f15c.glb",
  placeholder: {
    fuselageRadiusM: 0.8, wing: "trapezoid", wingRootAt: 0.44, wingRootChordM: 7.0, wingTipChordM: 1.8,
    wingSweepDeg: 45, tailplane: true, fins: 2, finCantDeg: 0, finHeightM: 3.0, canards: false,
  },
};

/** Endurance: agile for its size and full of fuel; the biggest, hottest thing in the sky and slow to roll. */
const SU27S: Airframe = drawnAbout({
  id: "su27s",
  name: "Su-27S",
  role: "Long-haul brawler",
  geometry: geometry(62, 14.7, 21.9, 4.22),
  mass: scaledMass(16_380, 9_400, 0.55, 14.7, 21.9),
  engine: engine(149_000, 245_200, 2.1e-5, 5.4e-5),
  aero: aero({
    clAlpha: 4.2, clMax: 2.02, clMaxAlphaRad: radians(30), clStallFloor: 0.55,
    cd0: 0.0225, inducedK: inducedK(14.7, 62, 0.74), alphaDepartureRad: radians(40),
  }),
  surfaces: SURFACES,
  flcs: flcs(9, 26, 180),
  gun: { ...GUNS.gsh301, muzzleOffsetM: [1.1, 0.4, 4.4] as const },
  missile: "r73",
  infrared: 1.8,
  nozzles: [[-1.25, -0.3, -10.5], [1.25, -0.3, -10.5]],
  nozzleRadiusM: 0.55,
  rails: tips(14.7, -2.0),
  cockpitEye: [0, 1.25, 6.4],
  placeholder: {
    fuselageRadiusM: 0.85, wing: "trapezoid", wingRootAt: 0.42, wingRootChordM: 6.8, wingTipChordM: 1.6,
    wingSweepDeg: 42, tailplane: true, fins: 2, finCantDeg: 0, finHeightM: 3.2, canards: false,
  },
});

/** A delta: the hardest first turn in the sky, and the fastest to bleed the speed it turned with. */
const M2000C: Airframe = drawnAbout({
  id: "m2000c",
  name: "Mirage 2000C",
  role: "First-turn delta",
  geometry: geometry(41, 9.13, 14.36, 5.0),
  mass: scaledMass(7_500, 3_160, 0.6, 9.13, 14.36),
  engine: engine(64_300, 95_100, 2.2e-5, 5.6e-5),
  aero: aero({
    clAlpha: 2.95, clMax: 1.78, clMaxAlphaRad: radians(31), clStallFloor: 0.6, clZero: 0.02,
    cd0: 0.019, waveDragPeak: 0.022, waveDragSupersonicFloor: 0.014, inducedK: inducedK(9.13, 41, 0.66),
    alphaDepartureRad: radians(38),
  }),
  surfaces: SURFACES,
  flcs: flcs(9, 29, 270),
  gun: GUNS.defa554,
  missile: "magic2",
  infrared: 1.1,
  nozzles: [[0, 0, -7.2]],
  nozzleRadiusM: 0.5,
  rails: pylons(3.3, -0.6, -0.45),
  cockpitEye: [0, 1.0, 3.4],
  placeholder: {
    fuselageRadiusM: 0.62, wing: "delta", wingRootAt: 0.38, wingRootChordM: 8.0, wingTipChordM: 0.3,
    wingSweepDeg: 58, tailplane: false, fins: 1, finCantDeg: 0, finHeightM: 2.6, canards: false,
  },
});

/** Small and cool: hard to see, hard to lock and hard to hit, and outclassed on paper by everything here. */
const F5E: Airframe = drawnAbout({
  id: "f5e",
  name: "F-5E",
  role: "Underdog",
  geometry: geometry(17.28, 8.13, 14.45, 2.36),
  mass: scaledMass(4_350, 2_000, 0.6, 8.13, 14.45),
  engine: engine(31_000, 44_400, 2.7e-5, 6.4e-5, 0.7),
  aero: aero({
    clAlpha: 4.4, clMax: 1.78, clMaxAlphaRad: radians(27), cd0: 0.0195,
    waveDragPeak: 0.026, waveDragSupersonicFloor: 0.016, inducedK: inducedK(8.13, 17.28, 0.84),
    alphaDepartureRad: radians(32),
  }),
  surfaces: SURFACES,
  flcs: flcs(7.3, 26, 240),
  gun: GUNS.m39,
  missile: "aim9p",
  infrared: 0.4,
  nozzles: [[-0.35, 0, -7.2], [0.35, 0, -7.2]],
  nozzleRadiusM: 0.3,
  rails: tips(8.13, -0.6),
  cockpitEye: [0, 0.95, 3.2],
  placeholder: {
    fuselageRadiusM: 0.55, wing: "trapezoid", wingRootAt: 0.47, wingRootChordM: 3.6, wingTipChordM: 0.7,
    wingSweepDeg: 32, tailplane: true, fins: 1, finCantDeg: 0, finHeightM: 2.0, canards: false,
  },
});

/** Small and quick, the newest jet here; kept honest with a modest engine and a short magazine. */
const JAS39C: Airframe = drawnAbout({
  id: "jas39c",
  name: "Gripen C",
  role: "Precision dogfighter",
  geometry: geometry(25.54, 8.4, 14.1, 3.8),
  mass: scaledMass(6_800, 2_400, 0.6, 8.4, 14.1),
  engine: engine(54_000, 80_500, 2.1e-5, 5.3e-5),
  aero: aero({
    clAlpha: 3.5, clMax: 1.88, clMaxAlphaRad: radians(29), clStallFloor: 0.55,
    cd0: 0.0205, waveDragPeak: 0.024, waveDragSupersonicFloor: 0.015, inducedK: inducedK(8.4, 25.54, 0.74),
    alphaDepartureRad: radians(36),
  }),
  surfaces: SURFACES,
  flcs: flcs(9, 26, 260),
  gun: GUNS.bk27,
  missile: "aim9m",
  infrared: 0.85,
  nozzles: [[0, 0, -7.0]],
  nozzleRadiusM: 0.42,
  rails: tips(8.4, -1.1),
  cockpitEye: [0, 1.0, 3.6],
  placeholder: {
    fuselageRadiusM: 0.6, wing: "delta", wingRootAt: 0.45, wingRootChordM: 6.4, wingTipChordM: 0.6,
    wingSweepDeg: 50, tailplane: false, fins: 1, finCantDeg: 0, finHeightM: 2.3, canards: true,
  },
});

export const AIRFRAMES: Record<AirframeId, Airframe> = {
  f16c: F16C,
  mig29a: MIG29A,
  fa18c: FA18C,
  f15c: F15C,
  su27s: SU27S,
  m2000c: M2000C,
  f5e: F5E,
  jas39c: JAS39C,
};

/**
 * The centre of gravity a placeholder is drawn about: 30% of the mean
 * aerodynamic chord of the wing it is drawn with, found the same way as the
 * real models' -- the root and tip chords, the sweep and the span give the
 * chord's length and where its leading edge is.
 */
export function placeholderCg(frame: Pick<Airframe, "geometry" | "placeholder">): BodyPoint {
  const shape = frame.placeholder;
  const length = frame.geometry.lengthM;
  const semiSpan = frame.geometry.wingSpanM / 2 - shape.fuselageRadiusM * 0.8;
  const taper = shape.wingTipChordM / shape.wingRootChordM;
  const mac = ((2 / 3) * shape.wingRootChordM * (1 + taper + taper * taper)) / (1 + taper);
  const macStation = ((semiSpan / 3) * (1 + 2 * taper)) / (1 + taper);
  const rootLeading = length / 2 - shape.wingRootAt * length;
  const macLeading = rootLeading - Math.tan(radians(shape.wingSweepDeg)) * macStation;
  return [0, 0, macLeading - 0.3 * mac];
}

/** A placeholder airframe, with its centre of gravity where its drawn wing puts it. */
function drawnAbout(frame: Omit<Airframe, "cg">): Airframe {
  return { ...frame, cg: placeholderCg(frame) };
}

/** A point measured on the model, as a position from the centre of gravity. */
export function fromModel(frame: Pick<Airframe, "cg">, point: BodyPoint): BodyPoint {
  return [point[0] - frame.cg[0], point[1] - frame.cg[1], point[2] - frame.cg[2]];
}

export const DEFAULT_AIRFRAME: AirframeId = "f16c";

export function isAirframeId(value: unknown): value is AirframeId {
  return typeof value === "string" && (AIRFRAME_IDS as readonly string[]).includes(value);
}

export function airframe(id: AirframeId | undefined): Airframe {
  return AIRFRAMES[id ?? DEFAULT_AIRFRAME] ?? F16C;
}

export function missileSpec(kind: MissileId | undefined): MissileSpec {
  return MISSILES[kind ?? "aim9m"] ?? MISSILES.aim9m;
}
