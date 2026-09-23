import type { Quaternion, Vector3 } from "three";
import type { EngineState } from "./engine";
import type { FlcsState } from "./flcs";

export type Team = "blue" | "red";

export interface ControlInput {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  fire: boolean;
  /** Missile pickle. It launches on the press, not while held. */
  missile?: boolean;
  /** Countermeasure release. One press dispenses one salvo. */
  flare?: boolean;
}

export type Loadout = "guns" | "fox2";

/**
 * What the missile's seeker is telling the pilot, as the tone in the headset.
 *
 * `search` is the seeker looking at nothing; `growl` is heat in the field of
 * view but not enough to hold; `lock` is a track the missile will launch on.
 */
export type SeekerTone = "off" | "search" | "growl" | "lock";

export interface SeekerState {
  tone: SeekerTone;
  targetId?: string;
  /** Signal over lock threshold, so 1 is just enough to hold a track. */
  signal: number;
  /** Flares already judged, so each one gets one chance to pull the track. */
  flaresSeen: number[];
}

export interface StoresState {
  /** How many rails were loaded at the start; zero in a guns-only fight. */
  missileStations: number;
  missiles: number;
  flares: number;
  missileHeld: boolean;
  flareHeld: boolean;
  salvoRemaining: number;
  salvoTimerS: number;
  launchCooldownS: number;
}

export type Subsystem = "cockpit" | "forward-fuselage" | "left-wing" | "right-wing" | "engine" | "tail";

export interface DamageState {
  integrity: number;
  subsystems: Record<Subsystem, number>;
  fuelLeakKgS: number;
  pilotIncapacitated: boolean;
  hitsTaken: number;
}

export interface AircraftState {
  id: string;
  team: Team;
  position: Vector3;
  velocity: Vector3;
  acceleration: Vector3;
  orientation: Quaternion;
  angularVelocity: Vector3;
  /** Where the stick and throttle actually are. */
  controls: ControlInput;
  /**
   * Where whoever is flying wants them.
   *
   * The two are separate because a hand cannot teleport. An agent that answers
   * once a second used to have its command applied as a step, which showed up
   * as the aeroplane snapping into a bank and snapping back out of it -- and in
   * one tick the control could move full scale, which no pilot and no actuator
   * can do.
   */
  commandedControls: ControlInput;
  flcs: FlcsState;
  engine: EngineState;
  massKg: number;
  aoaRad: number;
  sideslipRad: number;
  loadFactor: number;
  mach: number;
  specificExcessPowerMps: number;
  heightAboveGroundM: number;
  ammo: number;
  gunAccumulator: number;
  gunSpin: number;
  roundsThisBurst: number;
  stores: StoresState;
  seeker: SeekerState;
  damage: DamageState;
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

export type MissileTrack = { kind: "aircraft"; id: string } | { kind: "flare"; id: number };

export interface MissileState {
  id: number;
  ownerId: string;
  position: Vector3;
  previousPosition: Vector3;
  velocity: Vector3;
  age: number;
  motorRemainingS: number;
  massKg: number;
  track?: MissileTrack;
  flaresSeen: number[];
}

export interface FlareState {
  id: number;
  ownerId: string;
  position: Vector3;
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
  | "winchester"
  | "missile-launch"
  | "missile-decoyed"
  | "missile-lost"
  | "missile-detonation"
  | "missile-expired"
  | "flares";

export interface SimEvent {
  time: number;
  type: SimEventType;
  actorId?: string;
  targetId?: string;
  subsystem?: Subsystem;
  detail?: string;
  /** Where it happened, for events that are a place rather than an aircraft. */
  position?: [number, number, number];
}

export interface MatchState {
  time: number;
  tick: number;
  aircraft: AircraftState[];
  projectiles: ProjectileState[];
  missiles: MissileState[];
  flares: FlareState[];
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
  startLateralOffsetM: number;
  startAltitudeSplitM: number;
  startHeadingCrossingDeg: number;
  hardDeckAglM: number;
  arenaRadiusM: number;
  /** Guns only unless said otherwise, which is what every benchmark was flown with. */
  weapons?: Loadout;
}
