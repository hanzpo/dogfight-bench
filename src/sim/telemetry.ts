import { Euler, Vector3 } from "three";
import { EARTH_RADIUS_M } from "./config";
import { speedOfSound } from "./flight-model";
import type { AircraftState, MatchState, ScenarioConfig } from "./types";

export interface AircraftTelemetry {
  id: string;
  team: string;
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
  positionEnuM: [number, number, number];
  velocityEnuMps: [number, number, number];
  speedMps: number;
  mach: number;
  pitchDeg: number;
  rollDeg: number;
  yawDeg: number;
  angleOfAttackDeg: number;
  sideslipDeg: number;
  pitchRateDegS: number;
  rollRateDegS: number;
  yawRateDegS: number;
  loadFactorG: number;
  ammoRemaining: number;
  health: number;
  alive: boolean;
}

export interface AgentObservation {
  schemaVersion: 1;
  scenarioId: string;
  ownshipId: string;
  simTimeS: number;
  decisionSequence: number;
  aircraft: AircraftTelemetry[];
  relative: {
    opponentId: string;
    rangeM: number;
    closureRateMps: number;
    bearingDeg: number;
    elevationDeg: number;
    angleOffTailDeg: number;
  };
}

function toTelemetry(a: AircraftState, config: ScenarioConfig): AircraftTelemetry {
  const e = new Euler().setFromQuaternion(a.orientation, "YXZ");
  const latitude = config.originLatitudeDeg + (a.position.z / EARTH_RADIUS_M) * 180 / Math.PI;
  const longitude = config.originLongitudeDeg
    + (a.position.x / (EARTH_RADIUS_M * Math.cos(config.originLatitudeDeg * Math.PI / 180))) * 180 / Math.PI;
  return {
    id: a.id, team: a.team,
    latitudeDeg: latitude, longitudeDeg: longitude, altitudeM: a.position.y,
    positionEnuM: [a.position.x, a.position.y, a.position.z],
    velocityEnuMps: [a.velocity.x, a.velocity.y, a.velocity.z],
    speedMps: a.velocity.length(), mach: a.velocity.length() / speedOfSound(a.position.y),
    pitchDeg: e.x * 180 / Math.PI, yawDeg: e.y * 180 / Math.PI, rollDeg: e.z * 180 / Math.PI,
    angleOfAttackDeg: a.aoaRad * 180 / Math.PI, sideslipDeg: a.sideslipRad * 180 / Math.PI,
    pitchRateDegS: a.angularVelocity.x * 180 / Math.PI,
    yawRateDegS: a.angularVelocity.y * 180 / Math.PI,
    rollRateDegS: a.angularVelocity.z * 180 / Math.PI,
    loadFactorG: a.loadFactor, ammoRemaining: a.ammo, health: a.health, alive: a.alive,
  };
}

export function observationFor(state: MatchState, ownshipId: string, config: ScenarioConfig, sequence: number): AgentObservation {
  const own = state.aircraft.find((a) => a.id === ownshipId)!;
  const opponent = state.aircraft.find((a) => a.id !== ownshipId)!;
  const delta = opponent.position.clone().sub(own.position);
  const localDelta = delta.clone().applyQuaternion(own.orientation.clone().invert());
  const los = delta.clone().normalize();
  const relativeVelocity = opponent.velocity.clone().sub(own.velocity);
  const opponentForward = new Vector3(0, 0, 1).applyQuaternion(opponent.orientation);
  return {
    schemaVersion: 1, scenarioId: config.id, ownshipId, simTimeS: state.time, decisionSequence: sequence,
    aircraft: state.aircraft.map((a) => toTelemetry(a, config)),
    relative: {
      opponentId: opponent.id, rangeM: delta.length(), closureRateMps: -relativeVelocity.dot(los),
      bearingDeg: Math.atan2(localDelta.x, localDelta.z) * 180 / Math.PI,
      elevationDeg: Math.atan2(localDelta.y, Math.hypot(localDelta.x, localDelta.z)) * 180 / Math.PI,
      angleOffTailDeg: Math.acos(Math.max(-1, Math.min(1, opponentForward.dot(los)))) * 180 / Math.PI,
    },
  };
}
