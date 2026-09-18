import { Euler, Quaternion, Vector3 } from "three";
import { F16 } from "./config";
import type { AircraftState, MatchState, ScenarioConfig, Team } from "./types";

export const neutralMerge: ScenarioConfig = {
  id: "neutral-merge-v1",
  seed: 0xD06F16,
  fixedDt: 1 / 120,
  maxTime: 300,
  originLatitudeDeg: 36.0,
  originLongitudeDeg: -115.0,
  startAltitudeM: 4_500,
  startSpeedMps: 250,
  startSeparationM: 8_000,
};

function makeAircraft(id: string, team: Team, z: number, yaw: number, config: ScenarioConfig): AircraftState {
  const orientation = new Quaternion().setFromEuler(new Euler(0, yaw, 0, "YXZ"));
  const velocity = new Vector3(0, 0, config.startSpeedMps).applyQuaternion(orientation);
  return {
    id, team,
    position: new Vector3(0, config.startAltitudeM, z),
    velocity,
    orientation,
    angularVelocity: new Vector3(),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: 0.82, fire: false },
    aoaRad: 0, sideslipRad: 0, loadFactor: 1,
    ammo: F16.gun.ammunition, health: 1, gunAccumulator: 0, alive: true,
  };
}

export function createNeutralMerge(config: ScenarioConfig = neutralMerge): MatchState {
  return {
    time: 0, tick: 0,
    aircraft: [
      makeAircraft("blue-1", "blue", -config.startSeparationM / 2, 0, config),
      makeAircraft("red-1", "red", config.startSeparationM / 2, Math.PI, config),
    ],
    projectiles: [], events: [], finished: false,
  };
}
