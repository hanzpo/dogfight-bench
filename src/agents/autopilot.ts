import { Quaternion, Vector3 } from "three";
import { bodyAxes } from "../sim/flight-model";
import type { AgentObservation, AircraftTelemetry } from "../sim/telemetry";
import type { ControlInput } from "../sim/types";
import { THROTTLE_VALUES, type Maneuver, type TacticalAction } from "./action";

/**
 * Resolves a tactical command into stick and throttle.
 *
 * Every manoeuvre reduces to the same question a pilot asks: where should the
 * velocity vector point next? The manoeuvre picks that direction, and a single
 * controller rolls the lift vector onto it and pulls. That keeps the tactical
 * schema honest -- it is a way of choosing a goal, not a set of scripted
 * animations, and a model still loses if it picks the wrong goal.
 *
 * It is deliberately built from the same observation an agent receives, so an
 * agent can predict exactly what its command will do.
 */

const WORLD_UP = new Vector3(0, 1, 0);
const GRAVITY = 9.80665;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function telemetryAxes(aircraft: AircraftTelemetry) {
  const [x, y, z, w] = aircraft.orientationQuaternion;
  return bodyAxes(new Quaternion(x, y, z, w));
}

function toVector(values: [number, number, number]): Vector3 {
  return new Vector3(values[0], values[1], values[2]);
}

/** Rotates `direction` by `angle` about `axis`. */
function rotateAbout(direction: Vector3, axis: Vector3, angle: number): Vector3 {
  return direction.clone().applyQuaternion(new Quaternion().setFromAxisAngle(axis.clone().normalize(), angle));
}

/**
 * Which axis a manoeuvre is asking to point.
 *
 * Pursuit is about where the *nose* goes, because that is where the gun
 * points. Everything else is about where the *velocity vector* goes, because
 * that is the trajectory. Conflating the two biases every command by the angle
 * of attack, which at high g is twenty degrees of unintended dive.
 */
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
export function goalDirection(maneuver: Maneuver, observation: AgentObservation): Vector3 {
  const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
  const opponent = observation.aircraft.find((aircraft) => aircraft.id === observation.relative.opponentId)!;
  const axes = telemetryAxes(own);

  const ownPosition = toVector(own.positionM);
  const ownVelocity = toVector(own.velocityMps);
  const opponentPosition = toVector(opponent.positionM);
  const opponentVelocity = toVector(opponent.velocityMps);
  const lineOfSight = opponentPosition.clone().sub(ownPosition).normalize();

  // The gun solution already reports the lead direction in body axes.
  const { leadBearingDeg, leadElevationDeg } = observation.relative.gunSolution;
  const bearing = (leadBearingDeg * Math.PI) / 180;
  const elevation = (leadElevationDeg * Math.PI) / 180;
  const lead = axes.right
    .clone()
    .multiplyScalar(Math.sin(bearing) * Math.cos(elevation))
    .addScaledVector(axes.up, Math.sin(elevation))
    .addScaledVector(axes.nose, Math.cos(bearing) * Math.cos(elevation))
    .normalize();

  // Out-of-plane axis for the yo-yos: perpendicular to the line of sight,
  // in the vertical plane containing it.
  const acrossLineOfSight = lineOfSight.clone().cross(WORLD_UP).normalize();

  switch (maneuver) {
    case "pure_pursuit":
      return lineOfSight;
    case "lead_pursuit":
      return lead;
    case "lag_pursuit": {
      // Aim at where the opponent has been, which cuts closure and holds the
      // corner of their turn circle.
      const lagPoint = opponentPosition.clone().addScaledVector(opponentVelocity, -2.5);
      return lagPoint.sub(ownPosition).normalize();
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
  own: AircraftTelemetry,
  reference: "nose" | "flightPath" = "flightPath",
): { pitch: number; roll: number } {
  const axes = telemetryAxes(own);
  const velocity = toVector(own.velocityMps);
  const moving = velocity.lengthSq() > 1;
  const flightPath = moving ? velocity.clone().normalize() : axes.nose.clone();
  const pointing = reference === "nose" || !moving ? axes.nose : flightPath;

  const direction = goal.clone().normalize();
  const along = clamp(direction.dot(pointing), -1, 1);
  const errorRad = Math.acos(along);

  const across = direction.clone().addScaledVector(pointing, -along);
  if (across.lengthSq() < 1e-8) return { pitch: 0, roll: 0 };
  across.normalize();

  // Centripetal acceleration to spend on the turn, capped by the commanded g.
  // A shallow slope here tracks a gun solution far too slowly: a one-degree
  // error would take seconds to null. Saturating by about nine degrees keeps
  // large manoeuvres unchanged while making fine tracking crisp.
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
 * Small rudder input to null the last fraction of a degree of aim error.
 *
 * Sideslip is expensive, so this only engages when a gun solution is nearly
 * there and is deliberately weak.
 */
function gunTrackingYaw(observation: AgentObservation): number {
  const { gunSolution } = observation.relative;
  if (gunSolution.predictedMissM > 60 || !gunSolution.inLethalRange) return 0;
  return clamp(gunSolution.leadBearingDeg / 15, -0.25, 0.25);
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
export function groundAvoidanceUrgency(observation: AgentObservation): number {
  const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
  if (own.verticalSpeedMps >= 0) return 0;

  const climbRad = (own.flightPathAngleDeg * Math.PI) / 180;
  const pullG = Math.max(Math.min(own.availableLoadFactorG, 5), 1.5);
  const radius = (own.speedMps * own.speedMps) / (9.80665 * (pullG - 1));
  const recoveryLossM = radius * (1 - Math.cos(climbRad));

  // Recover with room to spare: a pull that finishes exactly at the hard deck
  // has no margin for the manoeuvre the model asks for on the way out.
  const margin = Math.max(observation.arena.hardDeckAglM * 2, 400);
  const needed = recoveryLossM * 2.5 + margin;
  const available = own.altitudeAglM;
  if (available > needed) return 0;
  return clamp((needed - available) / Math.max(needed * 0.6, margin), 0, 1);
}

export function resolveTactical(action: TacticalAction, observation: AgentObservation): ControlInput {
  const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
  const commanded = goalDirection(action.maneuver, observation);

  const urgency = groundAvoidanceUrgency(observation);
  const goal =
    urgency > 0
      ? commanded
          .clone()
          .multiplyScalar(1 - urgency)
          .addScaledVector(withClimb(toVector(own.velocityMps), 0.35), urgency)
          .normalize()
      : commanded;
  const targetG = Math.max(action.targetG, urgency * 7);
  // A recovery is about the trajectory, whatever the manoeuvre was asking for.
  const reference = urgency > 0.3 ? "flightPath" : referenceAxis(action.maneuver);

  const { pitch, roll } = steerToward(goal, targetG, own, reference);
  return {
    pitch,
    roll,
    yaw: gunTrackingYaw(observation),
    // Recovering from the ground is not the moment to be at idle.
    throttle: Math.max(THROTTLE_VALUES[action.throttle], urgency > 0.4 ? 0.85 : 0),
    fire: action.fire,
  };
}
