import type { Quaternion, Vector3 } from "three";

export type Team = "blue" | "red";

export interface ControlInput {
  /** Normalized stick axes: -1..1. */
  pitch: number;
  roll: number;
  yaw: number;
  /** 0..1; afterburner begins above 0.85. */
  throttle: number;
  fire: boolean;
}

export interface AircraftState {
  id: string;
  team: Team;
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  /** Body rates in rad/s: x=pitch, y=yaw, z=roll. */
  angularVelocity: Vector3;
  controls: ControlInput;
  aoaRad: number;
  sideslipRad: number;
  loadFactor: number;
  ammo: number;
  health: number;
  gunAccumulator: number;
  alive: boolean;
}

export interface ProjectileState {
  id: number;
  ownerId: string;
  position: Vector3;
  previousPosition: Vector3;
  velocity: Vector3;
  age: number;
}

export interface SimEvent {
  time: number;
  type: "gun-fired" | "hit" | "kill" | "timeout" | "ground-impact";
  actorId?: string;
  targetId?: string;
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
}
