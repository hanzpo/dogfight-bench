import type { Quaternion, Vector3 } from "three";
import type { EngineState } from "./engine";
import type { FlcsState } from "./flcs";

export type Team = "blue" | "red";

/**
 * Frame conventions used everywhere in the simulation.
 *
 * World (right-handed, matches the renderer): +x east, +y up, +z south.
 * The handedness is forced: with +y up and a right-handed basis, +z cannot also
 * be north. Compass heading is therefore `180 - yaw`, and latitude decreases as
 * +z increases.
 *
 * Body: the supplied glTF asset follows the glTF orientation rule, so the nose
 * is +z, the canopy is +y, and +x is the aircraft's *left*. Aerodynamics are
 * computed in the standard aerospace triad derived from that basis:
 * X_aero = +z_body (nose), Y_aero = -x_body (right), Z_aero = -y_body (down).
 */
export const BODY_TO_AERO = {
  noseBody: [0, 0, 1],
  rightBody: [-1, 0, 0],
  downBody: [0, -1, 0],
} as const;

export interface ControlInput {
  /** Longitudinal stick, -1..1. Positive pulls: it is a load-factor command. */
  pitch: number;
  /** Lateral stick, -1..1. Positive rolls right: it is a roll-rate command. */
  roll: number;
  /** Rudder pedals, -1..1. Positive yaws the nose right; commands sideslip. */
  yaw: number;
  /** 0..1; afterburner engages above 0.85. */
  throttle: number;
  fire: boolean;
}

export type Subsystem = "cockpit" | "forward-fuselage" | "left-wing" | "right-wing" | "engine" | "tail";

export interface DamageState {
  /** 1 = undamaged, 0 = destroyed. */
  integrity: number;
  /** Per-subsystem condition, 1 = healthy. */
  subsystems: Record<Subsystem, number>;
  /** Fuel lost per second through holed tanks. */
  fuelLeakKgS: number;
  pilotIncapacitated: boolean;
  hitsTaken: number;
}

export interface AircraftState {
  id: string;
  team: Team;
  /** World ENU position, metres. */
  position: Vector3;
  /** World velocity, m/s. */
  velocity: Vector3;
  /** World acceleration from the last step, m/s^2, including gravity. */
  acceleration: Vector3;
  /** Body-to-world rotation. */
  orientation: Quaternion;
  /** Aero body rates in rad/s stored as (p roll-right, q nose-up, r nose-right). */
  angularVelocity: Vector3;
  controls: ControlInput;
  flcs: FlcsState;
  engine: EngineState;
  massKg: number;
  aoaRad: number;
  sideslipRad: number;
  loadFactor: number;
  mach: number;
  /** Specific excess power, m/s: the single best scalar summary of who is winning. */
  specificExcessPowerMps: number;
  heightAboveGroundM: number;
  ammo: number;
  gunAccumulator: number;
  /** Barrel spin-up progress, 0..1. */
  gunSpin: number;
  roundsThisBurst: number;
  damage: DamageState;
  /** Convenience mirror of `damage.integrity` for existing consumers. */
  health: number;
  alive: boolean;
  destroyedBy?: string;
  destroyedReason?: string;
}

export interface ProjectileState {
  id: number;
  ownerId: string;
  position: Vector3;
  previousPosition: Vector3;
  velocity: Vector3;
  age: number;
}

export type SimEventType =
  | "gun-fired"
  | "hit"
  | "kill"
  | "timeout"
  | "ground-impact"
  | "departure"
  | "recovery"
  | "bingo-fuel"
  | "winchester";

export interface SimEvent {
  time: number;
  type: SimEventType;
  actorId?: string;
  targetId?: string;
  subsystem?: Subsystem;
  detail?: string;
}

export interface MatchState {
  time: number;
  tick: number;
  aircraft: AircraftState[];
  projectiles: ProjectileState[];
  events: SimEvent[];
  finished: boolean;
  winnerId?: string;
  finishReason?: string;
}

export interface ScenarioConfig {
  id: string;
  seed: number;
  fixedDt: number;
  maxTime: number;
  originLatitudeDeg: number;
  originLongitudeDeg: number;
  startAltitudeM: number;
  startSpeedMps: number;
  startSeparationM: number;
  /** Lateral offset between the two jets at the merge, metres. */
  startLateralOffsetM: number;
  /** Altitude split between the two jets, metres (blue low by half of this). */
  startAltitudeSplitM: number;
  /** Heading crossing angle at the merge, degrees. 180 is a pure head-on pass. */
  startHeadingCrossingDeg: number;
  /** Hard floor below which a match is called for terrain avoidance, metres AGL. */
  hardDeckAglM: number;
  /** Radius of the fight's airspace, metres. Leaving it forfeits. */
  arenaRadiusM: number;
}
