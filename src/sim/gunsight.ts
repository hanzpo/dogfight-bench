import { Quaternion, Vector3 } from "three";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { kineticEnergyJ, timeOfFlight } from "./ballistics";
import { GUN, MIN_LETHAL_ENERGY_J } from "./config";
import { bodyAxes } from "./flight-model";
import { clamp } from "../math";

export interface GunsightInput {
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  targetPosition: Vector3;
  targetVelocity: Vector3;
  targetAcceleration?: Vector3;
}

export interface GunsightSolution {
  direction: Vector3;
  leadRangeM: number;
  timeOfFlightS: number;
  impactSpeedMps: number;
  aimErrorRad: number;
  predictedMissM: number;
  inLethalRange: boolean;
}

export function hitThresholdM(rangeM: number): number {
  return TARGET_RADIUS_M + 2 * GUN.dispersionRad1Sigma * Math.max(rangeM, 0);
}

export const TARGET_RADIUS_M = 4.5;

export const MAX_TRACKING_TIME_OF_FLIGHT_S = 2.0;

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

    aim.y += 0.5 * GRAVITY_MPS2 * seconds * seconds;

    const muzzle = Math.max(GUN.muzzleVelocityMps + input.velocity.dot(aim.clone().normalize()), 1);
    const flight = timeOfFlight(aim.length(), muzzle, air.densityKgM3, air.speedOfSoundMps);
    seconds = Math.min(flight.seconds, GUN.maxLifeSeconds);
    impactSpeedMps = flight.impactSpeedMps;
  }

  const leadRangeM = aim.length();
  const direction = aim.clone().normalize();
  const aimErrorRad = Math.acos(clamp(direction.dot(axes.nose), -1, 1));
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
