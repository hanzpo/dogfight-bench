import { Quaternion, Vector3 } from "three";
import { bodyAxes } from "../sim/flight-model";
import { solveGunsight, wouldConnect } from "../sim/gunsight";
import { availableLoadFactor } from "../sim/performance";
import type { AgentObservation, AircraftTelemetry } from "../sim/telemetry";
import type { AircraftState, ControlInput } from "../sim/types";
import { THROTTLE_VALUES, type Maneuver, type TacticalAction } from "./action";

/**
 * Everything the autopilot needs to fly a standing order for one tick.
 *
 * A tactical command is an order that is flown continuously, not a stick
 * position captured at the moment a model answered. Resolving it against live
 * state every tick is the difference between an autopilot and a quarter-second
 * old snapshot of one, and it is what lets a gun solution ever converge.
 */
const WORLD_UP = new Vector3(0, 1, 0);
const GRAVITY = 9.80665;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toVector(values: [number, number, number]): Vector3 {
  return new Vector3(values[0], values[1], values[2]);
}

/** Rotates `direction` by `angle` about `axis`. */
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
    flightPathAngleRad: (own.flightPathAngleDeg * Math.PI) / 180,
  };
}

/**
 * Where the gun has to point for the rounds to arrive where the target will be.
 *
 * The same iteration the telemetry reports, run cheaply enough to use on every
 * tick of the simulation.
 */
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

/** Levels a direction into the horizontal plane, keeping its heading. */
function horizontal(direction: Vector3): Vector3 {
  const flat = new Vector3(direction.x, 0, direction.z);
  return flat.lengthSq() < 1e-9 ? new Vector3(0, 0, 1) : flat.normalize();
}

/** Tilts a horizontal direction by a climb angle. */
function withClimb(direction: Vector3, climbRad: number): Vector3 {
  const flat = horizontal(direction);
  return flat.multiplyScalar(Math.cos(climbRad)).addScaledVector(WORLD_UP, Math.sin(climbRad)).normalize();
}

/**
 * Where the manoeuvre wants the velocity vector to point, in world axes.
 */
export function goalDirection(maneuver: Maneuver, context: SteeringContext): Vector3 {
  const axes = bodyAxes(context.orientation);
  const lineOfSight = context.opponentPosition.clone().sub(context.position).normalize();
  const lead = leadDirection(context).direction;
  const ownVelocity = context.velocity;

  // Out-of-plane axis for the yo-yos: perpendicular to the line of sight, in
  // the vertical plane containing it.
  const acrossLineOfSight = lineOfSight.clone().cross(WORLD_UP).normalize();

  switch (maneuver) {
    case "pure_pursuit":
      return lineOfSight;
    case "lead_pursuit":
      return lead;
    case "lag_pursuit": {
      // Aim at where the opponent has been, which cuts closure and holds the
      // corner of their turn circle.
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
      // Turn hard into the attacker while descending, which is what forces an
      // overshoot when there is nothing left to trade but altitude.
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

/**
 * Turns "point the velocity vector there" into stick.
 *
 * The naive version of this rolls until the lift vector points at the goal and
 * pulls. That is wrong, and wrong in a way that is easy to miss: in a level
 * turn it banks to ninety degrees, leaving no vertical lift at all, so every
 * turn quietly descends. Instead, work out the acceleration the manoeuvre
 * actually needs -- centripetal acceleration toward the goal, plus one g to
 * hold the flight path up against gravity -- and point the lift vector at
 * *that*. Bank angle and load factor then fall out of the geometry, exactly as
 * they do for a pilot.
 */
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

  // A shallow slope tracks a gun solution far too slowly: a one-degree error
  // would take seconds to null. Saturating by about nine degrees keeps large
  // manoeuvres unchanged while making fine tracking crisp.
  const turnG = clamp(errorRad / 0.15, 0, 1) * (clamp(targetG, 1, 9) - 1);
  const required = across
    .clone()
    .multiplyScalar(turnG * GRAVITY)
    .add(new Vector3(0, GRAVITY, 0));
  // Thrust and drag own the along-track axis; lift only has to supply the rest.
  required.addScaledVector(flightPath, -required.dot(flightPath));

  const loadFactor = required.length() / GRAVITY;
  if (required.lengthSq() < 1e-8) return { pitch: 0, roll: 0 };
  const liftDirection = required.normalize();

  // Angle from the current lift vector to the one the manoeuvre needs.
  const bankError = Math.atan2(liftDirection.dot(axes.right), liftDirection.dot(axes.up));
  const roll = clamp(bankError * 1.8, -1, 1);

  // Pull only once the turn plane is roughly right, or the g goes into turning
  // the wrong way.
  const inPlane = clamp(Math.cos(bankError), 0, 1);
  const pitch = clamp(((loadFactor - 1) / 8) * inPlane, -1, 1);
  return { pitch, roll };
}

/**
 * How far the burst would pass from the target right now, in metres.
 *
 * Perpendicular distance from the target to the line of fire, which stays
 * finite at every angle.
 */
export function predictedMissM(context: SteeringContext): number {
  return leadDirection(context).missM;
}

/**
 * Small rudder input to null the last fraction of a degree of aim error.
 *
 * Sideslip is expensive, so this only engages when a gun solution is nearly
 * there and is deliberately weak.
 */
function gunTrackingYaw(context: SteeringContext): number {
  if (predictedMissM(context) > 60) return 0;
  const axes = bodyAxes(context.orientation);
  const { direction } = leadDirection(context);
  const bearing = Math.atan2(direction.dot(axes.right), direction.dot(axes.nose));
  return clamp(((bearing * 180) / Math.PI) / 15, -0.25, 0.25);
}

/**
 * Automatic ground collision avoidance.
 *
 * The real F-16 carries Auto-GCAS, and without an equivalent here the benchmark
 * mostly measures whether a model remembered the ground exists -- in testing,
 * every scripted match ended in a crash before a single round was fired. The
 * recovery engages on the same principle as the real system: work out the
 * altitude a pull to level would cost, and if the jet does not have it, take
 * the nose up. It blends in rather than snatching, so a model can still fly
 * itself into the dirt by pointing straight down with plenty of speed.
 */
export function groundAvoidanceUrgency(context: SteeringContext): number {
  if (context.velocity.y >= 0) return 0;

  const speed = context.velocity.length();
  const pullG = Math.max(Math.min(context.availableLoadFactorG, 5), 1.5);
  const radius = (speed * speed) / (GRAVITY * (pullG - 1));
  const recoveryLossM = radius * (1 - Math.cos(context.flightPathAngleRad));

  // Recover with room to spare: a pull that finishes exactly at the hard deck
  // has no margin for the manoeuvre the model asks for on the way out.
  const margin = Math.max(context.hardDeckAglM * 2, 400);
  const needed = recoveryLossM * 2.5 + margin;
  if (context.altitudeAglM > needed) return 0;
  return clamp((needed - context.altitudeAglM) / Math.max(needed * 0.6, margin), 0, 1);
}

/**
 * Flies a standing order for one tick.
 *
 * The trigger is gated on the live gun solution rather than on the value the
 * model chose, because a decision is up to a quarter of a second old and the
 * geometry moves a long way in that time. `fire` therefore means "shoot when
 * the pipper is on", which is what a pilot with a lead-computing sight does,
 * and it applies identically to every tactical agent so it advantages none of
 * them. Raw-schema agents keep direct control of the trigger.
 */
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
  // A recovery is about the trajectory, whatever the manoeuvre was asking for.
  const reference = urgency > 0.3 ? "flightPath" : referenceAxis(action.maneuver);

  const { pitch, roll } = steerToward(goal, targetG, context, reference);
  const shot = leadDirection(context);
  return {
    pitch,
    roll,
    yaw: gunTrackingYaw(context),
    // Recovering from the ground is not the moment to be at idle.
    throttle: Math.max(THROTTLE_VALUES[action.throttle], urgency > 0.4 ? 0.85 : 0),
    // Authorised only when the burst would actually connect: close enough that
    // the target's size covers the dispersion cone, and soon enough that they
    // are still there when the rounds arrive.
    fire: action.fire && shot.connects,
  };
}

export function resolveTacticalForObservation(
  action: TacticalAction,
  observation: AgentObservation,
): ControlInput {
  return resolveTactical(action, contextFromObservation(observation));
}
