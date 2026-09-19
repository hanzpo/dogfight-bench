import { Vector3 } from "three";
import { atmosphere, GRAVITY_MPS2, equivalentAirspeed } from "./atmosphere";
import { EARTH_RADIUS_M, FLCS, GEOMETRY, GUN, MIN_LETHAL_ENERGY_J } from "./config";
import { hitThresholdM, solveGunsight, wouldConnect } from "./gunsight";
import { bodyAxes } from "./flight-model";
import { LIMITER_CL, availableLoadFactor, sustainedLoadFactor } from "./performance";
import { terrainAwareness, type TerrainAwareness } from "./terrain-awareness";
import type { AircraftState, MatchState, ScenarioConfig, SimEvent, Subsystem } from "./types";
import { degrees, radians } from "../math";
import { clamp } from "../math";

export interface AircraftTelemetry {
  id: string;
  team: string;
  alive: boolean;

  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
  altitudeAglM: number;
  positionM: [number, number, number];
  velocityMps: [number, number, number];
  accelerationMps2: [number, number, number];
  orientationQuaternion: [number, number, number, number];

  speedMps: number;
  equivalentAirspeedMps: number;
  mach: number;
  headingDeg: number;
  trackDeg: number;
  pitchDeg: number;
  rollDeg: number;
  flightPathAngleDeg: number;
  verticalSpeedMps: number;

  angleOfAttackDeg: number;
  sideslipDeg: number;
  rollRateDegS: number;
  pitchRateDegS: number;
  yawRateDegS: number;

  loadFactorG: number;
  availableLoadFactorG: number;
  sustainedLoadFactorG: number;
  /**
   * Null when the aircraft is not turning.
   *
   * The radius is speed over turn rate, which is infinite with the wings level
   * -- and JSON has no infinity, so a number here would reach the server as
   * `null` anyway and be read as a number. It says so instead.
   */
  turnRadiusM: number | null;
  turnRateDegS: number;

  specificEnergyM: number;
  specificExcessPowerMps: number;
  cornerSpeedMps: number;

  throttle: number;
  afterburner: boolean;
  fuelKg: number;
  fuelFlowKgS: number;
  massKg: number;

  ammoRemaining: number;
  roundsThisBurst: number;
  gunSpin: number;

  health: number;
  hitsTaken: number;
  subsystems: Record<Subsystem, number>;
  limiterActive: boolean;
  departed: boolean;
  terrain: TerrainAwareness;
  controls: { pitch: number; roll: number; yaw: number; throttle: number; fire: boolean };
}

export interface GunSolution {
  timeOfFlightS: number;
  aimErrorDeg: number;
  predictedMissM: number;
  leadRangeM: number;
  leadBearingDeg: number;
  leadElevationDeg: number;
  inLethalRange: boolean;
  trackingSolution: boolean;
}

export interface RelativeTelemetry {
  opponentId: string;
  rangeM: number;
  closureRateMps: number;
  bearingDeg: number;
  elevationDeg: number;
  angleOffTailDeg: number;
  antennaTrainAngleDeg: number;
  lineOfSightRateDegS: number;
  energyAdvantageM: number;
  altitudeAdvantageM: number;
  gunSolution: GunSolution;
  threatened: boolean;
}

export interface AgentObservation {
  schemaVersion: 3;
  scenarioId: string;
  ownshipId: string;
  simTimeS: number;
  timeRemainingS: number;
  decisionSequence: number;
  secondsSinceLastDecisionS: number;
  aircraft: AircraftTelemetry[];
  relative: RelativeTelemetry;
  recentEvents: SimEvent[];
  arena: {
    hardDeckAglM: number;
    radiusM: number;
    distanceFromCentreM: number;
  };
}

/** The world is right-handed and y-up, which puts north at -z and south at +z. */
function compassHeading(east: number, south: number): number {
  return (((Math.atan2(east, -south) * 180) / Math.PI) + 360) % 360;
}

export function toTelemetry(aircraft: AircraftState, config: ScenarioConfig): AircraftTelemetry {
  const axes = bodyAxes(aircraft.orientation);
  const speed = aircraft.velocity.length();
  const air = atmosphere(aircraft.position.y);

  const latitudeDeg = config.originLatitudeDeg - ((aircraft.position.z / EARTH_RADIUS_M) * 180) / Math.PI;
  const longitudeDeg =
    config.originLongitudeDeg +
    ((aircraft.position.x / (EARTH_RADIUS_M * Math.cos(radians(config.originLatitudeDeg)))) * 180) /
      Math.PI;

  const flightPathAngleDeg = speed > 1e-3 ? (Math.asin(aircraft.velocity.y / speed) * 180) / Math.PI : 0;
  const bank = Math.atan2(axes.up.dot(axes.nose.clone().cross(new Vector3(0, 1, 0)).normalize()), axes.up.y);

  const availableG = availableLoadFactor(aircraft.position.y, speed, aircraft.massKg);

  const turnRateRadS = speed > 1e-3 ? (GRAVITY_MPS2 * Math.sqrt(Math.max(aircraft.loadFactor ** 2 - 1, 0))) / speed : 0;

  return {
    id: aircraft.id,
    team: aircraft.team,
    alive: aircraft.alive,

    latitudeDeg,
    longitudeDeg,
    altitudeM: aircraft.position.y,
    altitudeAglM: aircraft.heightAboveGroundM,
    positionM: [aircraft.position.x, aircraft.position.y, aircraft.position.z],
    velocityMps: [aircraft.velocity.x, aircraft.velocity.y, aircraft.velocity.z],
    accelerationMps2: [aircraft.acceleration.x, aircraft.acceleration.y, aircraft.acceleration.z],
    orientationQuaternion: aircraft.orientation.toArray() as [number, number, number, number],

    speedMps: speed,
    equivalentAirspeedMps: equivalentAirspeed(speed, aircraft.position.y),
    mach: aircraft.mach,
    headingDeg: compassHeading(axes.nose.x, axes.nose.z),
    trackDeg: compassHeading(aircraft.velocity.x, aircraft.velocity.z),
    pitchDeg: (Math.asin(clamp(axes.nose.y, -1, 1)) * 180) / Math.PI,
    rollDeg: degrees(bank),
    flightPathAngleDeg,
    verticalSpeedMps: aircraft.velocity.y,

    angleOfAttackDeg: degrees(aircraft.aoaRad),
    sideslipDeg: degrees(aircraft.sideslipRad),
    rollRateDegS: degrees(aircraft.angularVelocity.x),
    pitchRateDegS: degrees(aircraft.angularVelocity.y),
    yawRateDegS: degrees(aircraft.angularVelocity.z),

    loadFactorG: aircraft.loadFactor,
    availableLoadFactorG: availableG,
    sustainedLoadFactorG: sustainedLoadFactor(aircraft.position.y, speed, aircraft.massKg),
    turnRadiusM: turnRateRadS > 1e-6 ? speed / turnRateRadS : null,
    turnRateDegS: degrees(turnRateRadS),

    specificEnergyM: aircraft.position.y + (speed * speed) / (2 * GRAVITY_MPS2),
    specificExcessPowerMps: aircraft.specificExcessPowerMps,
    cornerSpeedMps: Math.sqrt(
      (2 * FLCS.maxLoadFactor * aircraft.massKg * GRAVITY_MPS2) /
        (air.densityKgM3 * GEOMETRY.wingAreaM2 * LIMITER_CL),
    ),

    throttle: aircraft.controls.throttle,
    afterburner: aircraft.engine.afterburner,
    fuelKg: aircraft.engine.fuelKg,
    fuelFlowKgS: aircraft.engine.fuelFlowKgS,
    massKg: aircraft.massKg,

    ammoRemaining: aircraft.ammo,
    roundsThisBurst: aircraft.roundsThisBurst,
    gunSpin: aircraft.gunSpin,

    health: aircraft.damage.integrity,
    hitsTaken: aircraft.damage.hitsTaken,
    subsystems: { ...aircraft.damage.subsystems },
    limiterActive: aircraft.flcs.limiterActive,
    departed: aircraft.flcs.departed,
    terrain: terrainAwareness({
      positionM: [aircraft.position.x, aircraft.position.y, aircraft.position.z],
      velocityMps: [aircraft.velocity.x, aircraft.velocity.y, aircraft.velocity.z],
      availableLoadFactorG: availableG,
      hardDeckAglM: config.hardDeckAglM,
    }),
    controls: { ...aircraft.controls },
  };
}

export function gunSolutionFor(shooter: AircraftState, target: AircraftState): GunSolution {
  const axes = bodyAxes(shooter.orientation);
  const solution = solveGunsight({
    position: shooter.position,
    velocity: shooter.velocity,
    orientation: shooter.orientation,
    targetPosition: target.position,
    targetVelocity: target.velocity,
    targetAcceleration: target.acceleration,
  });

  const local = new Vector3(
    solution.direction.dot(axes.right),
    solution.direction.dot(axes.up),
    solution.direction.dot(axes.nose),
  );
  return {
    timeOfFlightS: solution.timeOfFlightS,
    aimErrorDeg: degrees(solution.aimErrorRad),
    predictedMissM: solution.predictedMissM,
    leadRangeM: solution.leadRangeM,
    leadBearingDeg: (Math.atan2(local.x, local.z) * 180) / Math.PI,
    leadElevationDeg: (Math.atan2(local.y, Math.hypot(local.x, local.z)) * 180) / Math.PI,
    inLethalRange: solution.inLethalRange,
    trackingSolution: wouldConnect(solution),
  };
}

function relativeFor(own: AircraftState, opponent: AircraftState): RelativeTelemetry {
  const axes = bodyAxes(own.orientation);
  const delta = opponent.position.clone().sub(own.position);
  const range = delta.length();
  const lineOfSight = delta.clone().normalize();
  const relativeVelocity = opponent.velocity.clone().sub(own.velocity);

  const local = new Vector3(delta.dot(axes.right), delta.dot(axes.up), delta.dot(axes.nose));
  const opponentNose = bodyAxes(opponent.orientation).nose;

  const across = relativeVelocity.clone().addScaledVector(lineOfSight, -relativeVelocity.dot(lineOfSight));
  const lineOfSightRate = range > 1e-3 ? across.length() / range : 0;

  const ownEnergy = own.position.y + own.velocity.lengthSq() / (2 * GRAVITY_MPS2);
  const opponentEnergy = opponent.position.y + opponent.velocity.lengthSq() / (2 * GRAVITY_MPS2);

  const gunSolution = gunSolutionFor(own, opponent);
  const threat = gunSolutionFor(opponent, own);

  return {
    opponentId: opponent.id,
    rangeM: range,
    closureRateMps: -relativeVelocity.dot(lineOfSight),
    bearingDeg: (Math.atan2(local.x, local.z) * 180) / Math.PI,
    elevationDeg: (Math.atan2(local.y, Math.hypot(local.x, local.z)) * 180) / Math.PI,
    angleOffTailDeg: (Math.acos(clamp(opponentNose.dot(lineOfSight), -1, 1)) * 180) / Math.PI,
    antennaTrainAngleDeg: (Math.acos(clamp(axes.nose.dot(lineOfSight), -1, 1)) * 180) / Math.PI,
    lineOfSightRateDegS: degrees(lineOfSightRate),
    energyAdvantageM: ownEnergy - opponentEnergy,
    altitudeAdvantageM: own.position.y - opponent.position.y,
    gunSolution,
    threatened: threat.inLethalRange && threat.predictedMissM < hitThresholdM(threat.leadRangeM) * 3,
  };
}

export function observationFor(
  state: MatchState,
  ownshipId: string,
  config: ScenarioConfig,
  sequence: number,
  options: { secondsSinceLastDecisionS?: number; sinceEventIndex?: number } = {},
): AgentObservation {
  const own = state.aircraft.find((aircraft) => aircraft.id === ownshipId)!;
  const opponent = state.aircraft.find((aircraft) => aircraft.id !== ownshipId)!;

  return {
    schemaVersion: 3,
    scenarioId: config.id,
    ownshipId,
    simTimeS: state.time,
    timeRemainingS: Math.max(0, config.maxTime - state.time),
    decisionSequence: sequence,
    secondsSinceLastDecisionS: options.secondsSinceLastDecisionS ?? 0,
    aircraft: state.aircraft.map((aircraft) => toTelemetry(aircraft, config)),
    relative: relativeFor(own, opponent),
    recentEvents: state.events.slice(options.sinceEventIndex ?? state.events.length),
    arena: {
      hardDeckAglM: config.hardDeckAglM,
      radiusM: config.arenaRadiusM,
      distanceFromCentreM: Math.hypot(own.position.x, own.position.z),
    },
  };
}
