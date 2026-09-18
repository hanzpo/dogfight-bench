import { Vector3 } from "three";
import { atmosphere, GRAVITY_MPS2, equivalentAirspeed } from "./atmosphere";
import { EARTH_RADIUS_M, FLCS, GEOMETRY, GUN, MIN_LETHAL_ENERGY_J } from "./config";
import { kineticEnergyJ, projectileDeceleration } from "./ballistics";
import { bodyAxes } from "./flight-model";
import { LIMITER_CL, availableLoadFactor, sustainedLoadFactor } from "./performance";
import type { AircraftState, MatchState, ScenarioConfig, SimEvent, Subsystem } from "./types";

/**
 * Perfect-information telemetry.
 *
 * Both agents see the complete state of both aircraft. The point of the
 * benchmark is decision quality, not sensor modelling, so anything a pilot
 * could compute is computed here rather than left for the model to derive --
 * including the energy state and the gun solution, which is what air combat
 * actually turns on.
 */

export interface AircraftTelemetry {
  id: string;
  team: string;
  alive: boolean;

  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
  altitudeAglM: number;
  /** World position, metres: [east, up, south]. */
  positionM: [number, number, number];
  velocityMps: [number, number, number];
  accelerationMps2: [number, number, number];
  /** Body-to-world rotation as [x, y, z, w]. */
  orientationQuaternion: [number, number, number, number];

  speedMps: number;
  equivalentAirspeedMps: number;
  mach: number;
  /** Compass heading of the nose, degrees. */
  headingDeg: number;
  /** Compass heading of the velocity vector, degrees. */
  trackDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Climb angle of the velocity vector, degrees. */
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
  /** Turn radius the current load factor produces, metres. */
  turnRadiusM: number;
  turnRateDegS: number;

  /** Specific energy, metres: altitude plus the altitude the speed is worth. */
  specificEnergyM: number;
  specificExcessPowerMps: number;
  /** Ps if the jet were pulling its maximum sustained turn instead. */
  cornerSpeedMps: number;

  throttle: number;
  afterburner: boolean;
  fuelKg: number;
  fuelFlowKgS: number;
  massKg: number;

  ammoRemaining: number;
  roundsThisBurst: number;
  /** 0..1; the gun does not fire until this reaches 1. */
  gunSpin: number;

  health: number;
  hitsTaken: number;
  subsystems: Record<Subsystem, number>;
  limiterActive: boolean;
  departed: boolean;
  /** What the aircraft is currently being commanded to do. */
  controls: { pitch: number; roll: number; yaw: number; throttle: number; fire: boolean };
}

export interface GunSolution {
  /** Time a round would take to reach the target's predicted position, seconds. */
  timeOfFlightS: number;
  /** Angle between the gun line and the required lead, degrees. Zero is a kill. */
  aimErrorDeg: number;
  /** Where the nose has to point, as bearing and elevation from the nose. */
  leadBearingDeg: number;
  leadElevationDeg: number;
  /** True when rounds would still be lethal at that range. */
  inLethalRange: boolean;
  /** True when the solution is tight enough that firing is worthwhile. */
  trackingSolution: boolean;
}

export interface RelativeTelemetry {
  opponentId: string;
  rangeM: number;
  closureRateMps: number;
  /** Where the opponent is, relative to our nose. */
  bearingDeg: number;
  elevationDeg: number;
  /** Angle between the opponent's tail and our position: 0 is directly behind. */
  angleOffTailDeg: number;
  /** Angle between our nose and the opponent: 0 is pointing straight at them. */
  antennaTrainAngleDeg: number;
  /** How fast the line of sight is rotating, deg/s. High means an overshoot. */
  lineOfSightRateDegS: number;
  /** Difference in specific energy; positive means we have the advantage. */
  energyAdvantageM: number;
  altitudeAdvantageM: number;
  gunSolution: GunSolution;
  /** True when the opponent has a gun solution on us. */
  threatened: boolean;
}

export interface AgentObservation {
  schemaVersion: 2;
  scenarioId: string;
  ownshipId: string;
  simTimeS: number;
  timeRemainingS: number;
  decisionSequence: number;
  /** Simulated seconds since this agent last received an observation. */
  secondsSinceLastDecisionS: number;
  aircraft: AircraftTelemetry[];
  relative: RelativeTelemetry;
  /** Events since the previous observation, newest last. */
  recentEvents: SimEvent[];
  arena: {
    hardDeckAglM: number;
    radiusM: number;
    /** Distance from the arena centre, metres. */
    distanceFromCentreM: number;
  };
}

function compassHeading(east: number, south: number): number {
  // +z is south, so north is -z and the heading runs clockwise from there.
  return (((Math.atan2(east, -south) * 180) / Math.PI) + 360) % 360;
}

export function toTelemetry(aircraft: AircraftState, config: ScenarioConfig): AircraftTelemetry {
  const axes = bodyAxes(aircraft.orientation);
  const speed = aircraft.velocity.length();
  const air = atmosphere(aircraft.position.y);

  // +z is south, so latitude falls as z rises.
  const latitudeDeg = config.originLatitudeDeg - ((aircraft.position.z / EARTH_RADIUS_M) * 180) / Math.PI;
  const longitudeDeg =
    config.originLongitudeDeg +
    ((aircraft.position.x / (EARTH_RADIUS_M * Math.cos((config.originLatitudeDeg * Math.PI) / 180))) * 180) /
      Math.PI;

  const flightPathAngleDeg = speed > 1e-3 ? (Math.asin(aircraft.velocity.y / speed) * 180) / Math.PI : 0;
  const bank = Math.atan2(axes.up.dot(axes.nose.clone().cross(new Vector3(0, 1, 0)).normalize()), axes.up.y);

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
    pitchDeg: (Math.asin(Math.max(-1, Math.min(1, axes.nose.y))) * 180) / Math.PI,
    rollDeg: (bank * 180) / Math.PI,
    flightPathAngleDeg,
    verticalSpeedMps: aircraft.velocity.y,

    angleOfAttackDeg: (aircraft.aoaRad * 180) / Math.PI,
    sideslipDeg: (aircraft.sideslipRad * 180) / Math.PI,
    rollRateDegS: (aircraft.angularVelocity.x * 180) / Math.PI,
    pitchRateDegS: (aircraft.angularVelocity.y * 180) / Math.PI,
    yawRateDegS: (aircraft.angularVelocity.z * 180) / Math.PI,

    loadFactorG: aircraft.loadFactor,
    availableLoadFactorG: availableLoadFactor(aircraft.position.y, speed, aircraft.massKg),
    sustainedLoadFactorG: sustainedLoadFactor(aircraft.position.y, speed, aircraft.massKg),
    turnRadiusM: turnRateRadS > 1e-6 ? speed / turnRateRadS : Infinity,
    turnRateDegS: (turnRateRadS * 180) / Math.PI,

    specificEnergyM: aircraft.position.y + (speed * speed) / (2 * GRAVITY_MPS2),
    specificExcessPowerMps: aircraft.specificExcessPowerMps,
    // Slowest speed at which the structural limit is still reachable here.
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
    controls: { ...aircraft.controls },
  };
}

/**
 * Solves the gun problem the way a lead-computing sight does: iterate the
 * round's time of flight against where the target will be, then report how far
 * the nose is from where it needs to point.
 */
export function gunSolutionFor(shooter: AircraftState, target: AircraftState): GunSolution {
  const axes = bodyAxes(shooter.orientation);
  const air = atmosphere(shooter.position.y);

  let timeOfFlight = shooter.position.distanceTo(target.position) / GUN.muzzleVelocityMps;
  let lead = new Vector3();
  let impactSpeed: number = GUN.muzzleVelocityMps;
  for (let i = 0; i < 6; i += 1) {
    const predicted = target.position
      .clone()
      .addScaledVector(target.velocity, timeOfFlight)
      .addScaledVector(target.acceleration, 0.5 * timeOfFlight * timeOfFlight);
    lead = predicted.sub(shooter.position);
    const range = lead.length();

    // March the round's speed down the range to get a time of flight that
    // accounts for drag rather than assuming muzzle velocity all the way.
    let speed = GUN.muzzleVelocityMps + shooter.velocity.dot(lead.clone().normalize());
    let travelled = 0;
    let elapsed = 0;
    while (travelled < range && elapsed < GUN.maxLifeSeconds) {
      speed -= projectileDeceleration(speed, air.densityKgM3, air.speedOfSoundMps) * 0.01;
      travelled += speed * 0.01;
      elapsed += 0.01;
    }
    timeOfFlight = elapsed;
    impactSpeed = speed;
  }

  const leadDirection = lead.clone().normalize();
  const local = new Vector3(
    leadDirection.dot(axes.right),
    leadDirection.dot(axes.up),
    leadDirection.dot(axes.nose),
  );
  return {
    timeOfFlightS: timeOfFlight,
    aimErrorDeg: (Math.acos(Math.max(-1, Math.min(1, local.z))) * 180) / Math.PI,
    leadBearingDeg: (Math.atan2(local.x, local.z) * 180) / Math.PI,
    leadElevationDeg: (Math.atan2(local.y, Math.hypot(local.x, local.z)) * 180) / Math.PI,
    inLethalRange:
      kineticEnergyJ(Math.max(impactSpeed - target.velocity.length(), 0)) > MIN_LETHAL_ENERGY_J &&
      timeOfFlight < GUN.maxLifeSeconds,
    trackingSolution: false,
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

  // Line-of-sight rate is the component of relative velocity across the line of
  // sight, divided by range: the classic overshoot cue.
  const across = relativeVelocity.clone().addScaledVector(lineOfSight, -relativeVelocity.dot(lineOfSight));
  const lineOfSightRate = range > 1e-3 ? across.length() / range : 0;

  const ownEnergy = own.position.y + own.velocity.lengthSq() / (2 * GRAVITY_MPS2);
  const opponentEnergy = opponent.position.y + opponent.velocity.lengthSq() / (2 * GRAVITY_MPS2);

  const gunSolution = gunSolutionFor(own, opponent);
  gunSolution.trackingSolution = gunSolution.aimErrorDeg < 1.5 && gunSolution.inLethalRange && range < 2_500;
  const threat = gunSolutionFor(opponent, own);

  return {
    opponentId: opponent.id,
    rangeM: range,
    closureRateMps: -relativeVelocity.dot(lineOfSight),
    bearingDeg: (Math.atan2(local.x, local.z) * 180) / Math.PI,
    elevationDeg: (Math.atan2(local.y, Math.hypot(local.x, local.z)) * 180) / Math.PI,
    angleOffTailDeg:
      (Math.acos(Math.max(-1, Math.min(1, opponentNose.dot(lineOfSight.clone().negate())))) * 180) / Math.PI,
    antennaTrainAngleDeg: (Math.acos(Math.max(-1, Math.min(1, axes.nose.dot(lineOfSight)))) * 180) / Math.PI,
    lineOfSightRateDegS: (lineOfSightRate * 180) / Math.PI,
    energyAdvantageM: ownEnergy - opponentEnergy,
    altitudeAdvantageM: own.position.y - opponent.position.y,
    gunSolution,
    threatened: threat.aimErrorDeg < 3 && threat.inLethalRange && range < 2_500,
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
    schemaVersion: 2,
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
