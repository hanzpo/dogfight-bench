import { Quaternion, Vector3 } from "three";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { kineticEnergyJ, timeOfFlight } from "./ballistics";
import { GUN, MIN_LETHAL_ENERGY_J } from "./config";
import { bodyAxes } from "./flight-model";

/**
 * The lead-computing gunsight.
 *
 * One solver, used by the telemetry the agents read and by the autopilot that
 * pulls the trigger, so what a model is told about its shot is exactly what the
 * simulation will do with it.
 */

export interface GunsightInput {
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  targetPosition: Vector3;
  targetVelocity: Vector3;
  targetAcceleration?: Vector3;
}

export interface GunsightSolution {
  /** Unit vector the gun must point along, in world axes. */
  direction: Vector3;
  /** Range to the predicted intercept point, metres. */
  leadRangeM: number;
  timeOfFlightS: number;
  impactSpeedMps: number;
  /** Angle between the gun line and the required lead, radians. */
  aimErrorRad: number;
  /** Perpendicular distance the burst would pass from the target, metres. */
  predictedMissM: number;
  inLethalRange: boolean;
}

/**
 * Widest miss that can still connect, given the target's size and how far the
 * dispersion cone has spread by the time the rounds arrive.
 */
export function hitThresholdM(rangeM: number): number {
  return TARGET_RADIUS_M + 2 * GUN.dispersionRad1Sigma * Math.max(rangeM, 0);
}

/** Effective radius of an F-16 as a target: not the hull sphere, the structure. */
export const TARGET_RADIUS_M = 4.5;

/**
 * Longest time of flight worth shooting at, seconds.
 *
 * The rounds still carry lethal energy well beyond this, but a target that has
 * five seconds of warning is simply somewhere else when they arrive. Without a
 * ceiling the aim geometry lines up at five kilometres and both the shoot cue
 * and the agents' triggers fire at a shot nobody could make.
 */
export const MAX_TRACKING_TIME_OF_FLIGHT_S = 2.0;

/** True when a burst fired now would actually connect. */
export function wouldConnect(solution: GunsightSolution): boolean {
  return (
    solution.inLethalRange &&
    solution.timeOfFlightS < MAX_TRACKING_TIME_OF_FLIGHT_S &&
    solution.predictedMissM < hitThresholdM(solution.leadRangeM)
  );
}

export function solveGunsight(input: GunsightInput): GunsightSolution {
  const air = atmosphere(input.position.y);
  const axes = bodyAxes(input.orientation);

  let seconds = input.targetPosition.distanceTo(input.position) / GUN.muzzleVelocityMps;
  let aim = input.targetPosition.clone().sub(input.position);
  let impactSpeedMps: number = GUN.muzzleVelocityMps;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    aim = input.targetPosition
      .clone()
      .addScaledVector(input.targetVelocity, seconds)
      .addScaledVector(input.targetAcceleration ?? ZERO, 0.5 * seconds * seconds)
      .sub(input.position);

    // Rounds fall on the way. Aiming straight at the intercept point puts the
    // burst several metres low at a kilometre, which is a clean miss.
    aim.y += 0.5 * GRAVITY_MPS2 * seconds * seconds;

    const muzzle = Math.max(GUN.muzzleVelocityMps + input.velocity.dot(aim.clone().normalize()), 1);
    const flight = timeOfFlight(aim.length(), muzzle, air.densityKgM3, air.speedOfSoundMps);
    // Beyond the round's life the answer is meaningless, and left unclamped the
    // iteration runs away: a long time of flight throws the predicted intercept
    // kilometres downrange, which lengthens the next time of flight, and two
    // more passes overflow into NaN.
    seconds = Math.min(flight.seconds, GUN.maxLifeSeconds);
    impactSpeedMps = flight.impactSpeedMps;
  }

  const leadRangeM = aim.length();
  const direction = aim.clone().normalize();
  const aimErrorRad = Math.acos(Math.max(-1, Math.min(1, direction.dot(axes.nose))));
  const closingSpeed = Math.abs(impactSpeedMps - input.targetVelocity.dot(direction));

  return {
    direction,
    leadRangeM,
    timeOfFlightS: seconds,
    impactSpeedMps,
    aimErrorRad,
    predictedMissM: aimErrorRad >= Math.PI / 2 ? leadRangeM : Math.sin(aimErrorRad) * leadRangeM,
    inLethalRange:
      Number.isFinite(closingSpeed) &&
      kineticEnergyJ(closingSpeed) > MIN_LETHAL_ENERGY_J &&
      seconds < GUN.maxLifeSeconds,
  };
}

/**
 * Where a round fired right now would be after travelling `rangeM`.
 *
 * This is what a gunsight reticle marks: not where the nose points, but where
 * the bullets actually go once drop is accounted for. Drawing it lets a person
 * see the same shot the agents are told about.
 */
export function bulletImpactPoint(
  position: Vector3,
  velocity: Vector3,
  orientation: Quaternion,
  rangeM: number,
): Vector3 {
  const air = atmosphere(position.y);
  const nose = bodyAxes(orientation).nose;
  const muzzle = Math.max(GUN.muzzleVelocityMps + velocity.dot(nose), 1);
  const seconds = Math.min(
    timeOfFlight(Math.max(rangeM, 1), muzzle, air.densityKgM3, air.speedOfSoundMps).seconds,
    GUN.maxLifeSeconds,
  );
  return position
    .clone()
    .addScaledVector(nose, rangeM)
    .add(new Vector3(0, -0.5 * GRAVITY_MPS2 * seconds * seconds, 0));
}

const ZERO = new Vector3();
