import { Euler, Quaternion, Vector3 } from "three";
import { GUN, MASS } from "../../src/sim/config";
import { createDamageState } from "../../src/sim/damage";
import { thrustAtPower } from "../../src/sim/engine";
import { createFlcsState } from "../../src/sim/flcs";
import { atmosphere } from "../../src/sim/atmosphere";
import { stepAircraft } from "../../src/sim/flight-model";
import { trimLevelFlight, trimPower } from "../../src/sim/trim";
import type { AircraftState, ControlInput } from "../../src/sim/types";
import { degrees } from "../../src/math";
import { clamp } from "../../src/math";

export const DT = 1 / 120;

export interface TestAircraftOptions {
  altitudeM: number;
  speedMps: number;
  fuelFraction?: number;
  bankRad?: number;
  headingRad?: number;
}

export function makeTestAircraft(options: TestAircraftOptions): AircraftState {
  const fuelKg = MASS.internalFuelKg * (options.fuelFraction ?? MASS.startFuelFraction);
  const massKg = MASS.emptyKg + fuelKg;
  const trim = trimLevelFlight(options.altitudeM, options.speedMps, massKg);
  const yaw = options.headingRad ?? 0;
  const orientation = new Quaternion().setFromEuler(new Euler(-trim.alphaRad, yaw, options.bankRad ?? 0, "YXZ"));
  const air = atmosphere(options.altitudeM);
  const power = trimPower(trim.throttle);
  return {
    id: "probe",
    team: "blue",
    position: new Vector3(0, options.altitudeM, 0),
    velocity: new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(options.speedMps),
    acceleration: new Vector3(),
    orientation,
    angularVelocity: new Vector3(),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: trim.throttle, fire: false },
    commandedControls: { pitch: 0, roll: 0, yaw: 0, throttle: trim.throttle, fire: false },
    flcs: createFlcsState(),
    engine: {
      power,
      fuelKg,
      thrustN: thrustAtPower(power, options.altitudeM, options.speedMps / air.speedOfSoundMps),
      fuelFlowKgS: 0,
      afterburner: power > 1.02,
    },
    massKg,
    aoaRad: trim.alphaRad,
    sideslipRad: 0,
    loadFactor: 1,
    mach: options.speedMps / air.speedOfSoundMps,
    specificExcessPowerMps: 0,
    heightAboveGroundM: options.altitudeM,
    ammo: GUN.ammunition,
    gunAccumulator: 0,
    gunSpin: 0,
    roundsThisBurst: 0,
    damage: createDamageState(),
    health: 1,
    alive: true,
  };
}

export function cloneAircraft(aircraft: AircraftState): AircraftState {
  return {
    ...aircraft,
    position: aircraft.position.clone(),
    velocity: aircraft.velocity.clone(),
    acceleration: aircraft.acceleration.clone(),
    orientation: aircraft.orientation.clone(),
    angularVelocity: aircraft.angularVelocity.clone(),
    controls: { ...aircraft.controls },
    commandedControls: { ...aircraft.commandedControls },
    flcs: { ...aircraft.flcs },
    engine: { ...aircraft.engine },
    damage: { ...aircraft.damage, subsystems: { ...aircraft.damage.subsystems } },
  };
}

export function fly(aircraft: AircraftState, seconds: number, controls: Partial<ControlInput>): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i += 1) {
    aircraft.commandedControls = { ...aircraft.commandedControls, ...controls };
    stepAircraft(aircraft, DT);
  }
}

export function turnRateDegS(aircraft: AircraftState): number {
  const before = Math.atan2(aircraft.velocity.x, aircraft.velocity.z);
  const probe = cloneAircraft(aircraft);
  stepAircraft(probe, DT);
  const after = Math.atan2(probe.velocity.x, probe.velocity.z);
  let delta = after - before;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return (-delta / DT) * (180 / Math.PI);
}

export function currentBank(aircraft: AircraftState): number {
  const up = new Vector3(0, 1, 0).applyQuaternion(aircraft.orientation);
  const nose = new Vector3(0, 0, 1).applyQuaternion(aircraft.orientation);
  const right = nose.clone().cross(new Vector3(0, 1, 0)).normalize();
  return Math.atan2(up.dot(right), up.y);
}

export interface TurnResult {
  speedMps: number;
  turnRateDegS: number;
  loadFactor: number;
  altitudeM: number;
  alphaDeg: number;
}

export function sustainedTurn(altitudeM: number, entrySpeedMps: number, seconds = 120): TurnResult {
  const aircraft = makeTestAircraft({ altitudeM, speedMps: entrySpeedMps });
  for (let i = 0; i < Math.round(seconds / DT); i += 1) {
    const n = Math.max(aircraft.loadFactor, 1.02);
    const targetBank = Math.acos(Math.min(1, 1 / n));
    const altitudeError = aircraft.position.y - altitudeM;
    const verticalSpeed = aircraft.velocity.y;
    aircraft.commandedControls = {
      pitch: 1,
      roll: clamp((targetBank - currentBank(aircraft)) * 2.5 + altitudeError * 0.0015 + verticalSpeed * 0.02, -1, 1),
      yaw: 0,
      throttle: 1,
      fire: false,
    };
    stepAircraft(aircraft, DT);
  }
  return {
    speedMps: aircraft.velocity.length(),
    turnRateDegS: Math.abs(turnRateDegS(aircraft)),
    loadFactor: aircraft.loadFactor,
    altitudeM: aircraft.position.y,
    alphaDeg: degrees(aircraft.aoaRad),
  };
}

export function instantaneousTurn(altitudeM: number, speedMps: number): TurnResult {
  const aircraft = makeTestAircraft({ altitudeM, speedMps });
  let peak = 0;
  let peakState = cloneAircraft(aircraft);
  for (let i = 0; i < Math.round(6 / DT); i += 1) {
    const n = Math.max(aircraft.loadFactor, 1.02);
    const targetBank = Math.acos(Math.min(1, 1 / n));
    aircraft.commandedControls = {
      pitch: 1,
      roll: clamp((targetBank - currentBank(aircraft)) * 2.5, -1, 1),
      yaw: 0,
      throttle: 1,
      fire: false,
    };
    stepAircraft(aircraft, DT);
    const rate = Math.abs(turnRateDegS(aircraft));
    if (rate > peak) {
      peak = rate;
      peakState = cloneAircraft(aircraft);
    }
  }
  return {
    speedMps: peakState.velocity.length(),
    turnRateDegS: peak,
    loadFactor: peakState.loadFactor,
    altitudeM: peakState.position.y,
    alphaDeg: degrees(peakState.aoaRad),
  };
}
