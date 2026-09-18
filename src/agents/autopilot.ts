import { Quaternion, Vector3 } from "three";
import { bodyAxes } from "../sim/flight-model";
import { solveGunsight, wouldConnect } from "../sim/gunsight";
import { availableLoadFactor } from "../sim/performance";
import { terrainHeight } from "../sim/terrain";
import type { AgentObservation, AircraftTelemetry } from "../sim/telemetry";
import type { AircraftState, ControlInput } from "../sim/types";
import { THROTTLE_VALUES, type Maneuver, type TacticalAction } from "./action";
import { degrees, radians } from "../math";
import { clamp } from "../math";

const WORLD_UP = new Vector3(0, 1, 0);
const GRAVITY = 9.80665;


function toVector(values: [number, number, number]): Vector3 {
  return new Vector3(values[0], values[1], values[2]);
}

function rotateAbout(direction: Vector3, axis: Vector3, angle: number): Vector3 {
  return direction.clone().applyQuaternion(new Quaternion().setFromAxisAngle(axis.clone().normalize(), angle));
}

export interface SteeringContext {
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  opponentPosition: Vector3;
  opponentVelocity: Vector3;
  altitudeAglM: number;
  hardDeckAglM: number;
  availableLoadFactorG: number;
  flightPathAngleRad: number;
}

export function contextFromState(
  own: AircraftState,
  opponent: AircraftState,
  hardDeckAglM: number,
): SteeringContext {
  const speed = Math.max(own.velocity.length(), 1e-6);
  return {
    position: own.position,
    velocity: own.velocity,
    orientation: own.orientation,
    opponentPosition: opponent.position,
    opponentVelocity: opponent.velocity,
    altitudeAglM: own.heightAboveGroundM,
    hardDeckAglM,
    availableLoadFactorG: availableLoadFactor(own.position.y, speed, own.massKg),
    flightPathAngleRad: Math.asin(clamp(own.velocity.y / speed, -1, 1)),
  };
}

export function contextFromObservation(observation: AgentObservation): SteeringContext {
  const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
  const opponent = observation.aircraft.find((aircraft) => aircraft.id === observation.relative.opponentId)!;
  const [x, y, z, w] = own.orientationQuaternion;
  return {
    position: toVector(own.positionM),
    velocity: toVector(own.velocityMps),
    orientation: new Quaternion(x, y, z, w),
    opponentPosition: toVector(opponent.positionM),
    opponentVelocity: toVector(opponent.velocityMps),
    altitudeAglM: own.altitudeAglM,
    hardDeckAglM: observation.arena.hardDeckAglM,
    availableLoadFactorG: own.availableLoadFactorG,
    flightPathAngleRad: radians(own.flightPathAngleDeg),
  };
}

export function leadDirection(context: SteeringContext): {
  direction: Vector3;
  rangeM: number;
  missM: number;
  lethal: boolean;
  connects: boolean;
} {
  const solution = solveGunsight({
    position: context.position,
    velocity: context.velocity,
    orientation: context.orientation,
    targetPosition: context.opponentPosition,
    targetVelocity: context.opponentVelocity,
  });
  return {
    direction: solution.direction,
    rangeM: solution.leadRangeM,
    missM: solution.predictedMissM,
    lethal: solution.inLethalRange,
    connects: wouldConnect(solution),
  };
}

export function referenceAxis(maneuver: Maneuver): "nose" | "flightPath" {
  switch (maneuver) {
    case "pure_pursuit":
    case "lead_pursuit":
    case "lag_pursuit":
    case "high_yoyo":
    case "low_yoyo":
      return "nose";
    default:
      return "flightPath";
  }
}

function horizontal(direction: Vector3): Vector3 {
  const flat = new Vector3(direction.x, 0, direction.z);
  return flat.lengthSq() < 1e-9 ? new Vector3(0, 0, 1) : flat.normalize();
}

function withClimb(direction: Vector3, climbRad: number): Vector3 {
  const flat = horizontal(direction);
  return flat.multiplyScalar(Math.cos(climbRad)).addScaledVector(WORLD_UP, Math.sin(climbRad)).normalize();
}

export function goalDirection(maneuver: Maneuver, context: SteeringContext): Vector3 {
  const axes = bodyAxes(context.orientation);
  const lineOfSight = context.opponentPosition.clone().sub(context.position).normalize();
  const lead = leadDirection(context).direction;
  const ownVelocity = context.velocity;

  const acrossLineOfSight = lineOfSight.clone().cross(WORLD_UP).normalize();

  switch (maneuver) {
    case "pure_pursuit":
      return lineOfSight;
    case "lead_pursuit":
      return lead;
    case "lag_pursuit": {
      const lagPoint = context.opponentPosition.clone().addScaledVector(context.opponentVelocity, -2.5);
      return lagPoint.sub(context.position).normalize();
    }
    case "break_left":
      return withClimb(rotateAbout(horizontal(ownVelocity), WORLD_UP, Math.PI / 2), -0.05);
    case "break_right":
      return withClimb(rotateAbout(horizontal(ownVelocity), WORLD_UP, -Math.PI / 2), -0.05);
    case "high_yoyo":
      return rotateAbout(lead, acrossLineOfSight, -0.6).normalize();
    case "low_yoyo":
      return rotateAbout(lead, acrossLineOfSight, 0.5).normalize();
    case "vertical_reversal":
      return WORLD_UP.clone();
    case "defensive_spiral": {
      const intoAttacker = rotateAbout(lineOfSight, WORLD_UP, Math.PI / 3);
      return withClimb(intoAttacker, -0.5);
    }
    case "extend":
      return withClimb(lineOfSight.clone().negate(), -0.04);
    case "climb":
      return withClimb(ownVelocity, 0.6);
    case "dive":
      return withClimb(ownVelocity, -0.6);
    case "level":
    default:
      return horizontal(ownVelocity);
  }
  void axes;
}

export function steerToward(
  goal: Vector3,
  targetG: number,
  context: SteeringContext,
  reference: "nose" | "flightPath" = "flightPath",
): { pitch: number; roll: number } {
  const axes = bodyAxes(context.orientation);
  const moving = context.velocity.lengthSq() > 1;
  const flightPath = moving ? context.velocity.clone().normalize() : axes.nose.clone();
  const pointing = reference === "nose" || !moving ? axes.nose : flightPath;

  const direction = goal.clone().normalize();
  const along = clamp(direction.dot(pointing), -1, 1);
  const errorRad = Math.acos(along);

  const across = direction.clone().addScaledVector(pointing, -along);
  if (across.lengthSq() < 1e-8) return { pitch: 0, roll: 0 };
  across.normalize();

  const turnG = clamp(errorRad / 0.15, 0, 1) * (clamp(targetG, 1, 9) - 1);
  const required = across
    .clone()
    .multiplyScalar(turnG * GRAVITY)
    .add(new Vector3(0, GRAVITY, 0));
  required.addScaledVector(flightPath, -required.dot(flightPath));

  const loadFactor = required.length() / GRAVITY;
  if (required.lengthSq() < 1e-8) return { pitch: 0, roll: 0 };
  const liftDirection = required.normalize();

  const bankError = Math.atan2(liftDirection.dot(axes.right), liftDirection.dot(axes.up));
  const roll = clamp(bankError * 1.8, -1, 1);

  const inPlane = clamp(Math.cos(bankError), 0, 1);
  const pitch = clamp(((loadFactor - 1) / 8) * inPlane, -1, 1);
  return { pitch, roll };
}

export function predictedMissM(context: SteeringContext): number {
  return leadDirection(context).missM;
}

function gunTrackingYaw(context: SteeringContext): number {
  if (predictedMissM(context) > 60) return 0;
  const axes = bodyAxes(context.orientation);
  const { direction } = leadDirection(context);
  const bearing = Math.atan2(direction.dot(axes.right), direction.dot(axes.nose));
  return clamp(degrees(bearing) / 15, -0.25, 0.25);
}

const GROUND_LOOK_AHEAD_S = 12;
const GROUND_LOOK_AHEAD_SAMPLES = 8;

function projectedClearanceM(context: SteeringContext): number {
  const speed = context.velocity.lengthSq();
  if (speed < 1) return context.altitudeAglM;

  let minimum = context.altitudeAglM;
  for (let step = 1; step <= GROUND_LOOK_AHEAD_SAMPLES; step += 1) {
    const t = (step / GROUND_LOOK_AHEAD_SAMPLES) * GROUND_LOOK_AHEAD_S;
    const x = context.position.x + context.velocity.x * t;
    const y = context.position.y + context.velocity.y * t;
    const z = context.position.z + context.velocity.z * t;
    const clearance = y - terrainHeight(x, z);
    if (clearance < minimum) minimum = clearance;
  }
  return minimum;
}

export function groundAvoidanceUrgency(context: SteeringContext): number {
  const speed = context.velocity.length();
  const pullG = Math.max(Math.min(context.availableLoadFactorG, 5), 1.5);
  const radius = (speed * speed) / (GRAVITY * (pullG - 1));

  const margin = Math.max(context.hardDeckAglM * 2, 400);

  let urgency = 0;

  if (context.velocity.y < 0) {
    const recoveryLossM = radius * (1 - Math.cos(context.flightPathAngleRad));
    const needed = recoveryLossM * 2.5 + margin;
    if (context.altitudeAglM < needed) {
      urgency = clamp((needed - context.altitudeAglM) / Math.max(needed * 0.6, margin), 0, 1);
    }
  }

  const ahead = projectedClearanceM(context);
  const groundRisingM = context.altitudeAglM - ahead;
  if (groundRisingM > 0 && ahead < margin) {
    urgency = Math.max(urgency, clamp((margin - ahead) / margin, 0, 1));
  }

  return urgency;
}

export function resolveTactical(action: TacticalAction, context: SteeringContext): ControlInput {
  const commanded = goalDirection(action.maneuver, context);

  const urgency = groundAvoidanceUrgency(context);
  const goal =
    urgency > 0
      ? commanded
          .clone()
          .multiplyScalar(1 - urgency)
          .addScaledVector(withClimb(context.velocity, 0.35), urgency)
          .normalize()
      : commanded;
  const targetG = Math.max(action.targetG, urgency * 7);
  const reference = urgency > 0.3 ? "flightPath" : referenceAxis(action.maneuver);

  const { pitch, roll } = steerToward(goal, targetG, context, reference);
  const shot = leadDirection(context);
  return {
    pitch,
    roll,
    yaw: gunTrackingYaw(context),
    throttle: Math.max(action.throttleFraction ?? THROTTLE_VALUES[action.throttle], urgency > 0.4 ? 0.85 : 0),
    fire: action.fire && shot.connects,
  };
}

export function resolveTacticalForObservation(
  action: TacticalAction,
  observation: AgentObservation,
): ControlInput {
  return resolveTactical(action, contextFromObservation(observation));
}
