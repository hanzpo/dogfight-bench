import { GRAVITY_MPS2 } from "./atmosphere";
import { alphaForLiftCoefficient, liftCoefficient as liftCoefficientAt } from "./aero";
import { F16_FLIGHT, FLCS, type FlcsSpec, type FlightSpec } from "./config";
import { clamp } from "../math";

export interface FlcsState {
  pitch: number;
  roll: number;
  yaw: number;
  pitchWashout: number;
  alphaIntegralRad: number;
  commandedAlphaRad: number;
  yawWashout: number;
  departed: boolean;
  commandedG: number;
  limiterActive: boolean;
}

export function createFlcsState(): FlcsState {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    pitchWashout: 0,
    alphaIntegralRad: 0,
    commandedAlphaRad: 0,
    yawWashout: 0,
    departed: false,
    commandedG: 1,
    limiterActive: false,
  };
}

export interface FlcsInputs {
  pitchStick: number;
  rollStick: number;
  yawPedal: number;
  alphaRad: number;
  betaRad: number;
  p: number;
  q: number;
  r: number;
  trueAirspeedMps: number;
  dynamicPressurePa: number;
  loadFactor: number;
  massKg: number;
  gravityAlongBodyUp: number;
}

function slew(current: number, command: number, maxRatePerSecond: number, dt: number): number {
  const limit = maxRatePerSecond * dt;
  return current + clamp(command - current, -limit, limit);
}

export function gainSchedule(dynamicPressurePa: number, flcs: FlcsSpec = FLCS): number {
  return clamp(flcs.referenceQ / Math.max(dynamicPressurePa, flcs.minGainScheduleQ), 0.25, 2.5);
}

export function stepFlcs(state: FlcsState, input: FlcsInputs, dt: number, flight: FlightSpec = F16_FLIGHT): FlcsState {
  const { aero, flcs, geometry, surfaces } = flight;
  const schedule = gainSchedule(input.dynamicPressurePa, flcs);
  const speed = Math.max(input.trueAirspeedMps, 30);
  const halfSpan = geometry.wingSpanM / (2 * speed);
  const pHat = input.p * halfSpan;
  const rHat = input.r * halfSpan;

  const departed =
    Math.abs(input.alphaRad) > aero.alphaDepartureRad || Math.abs(input.betaRad) > aero.betaDepartureRad
      ? true
      : state.departed &&
        !(Math.abs(input.alphaRad) < 0.35 && Math.abs(input.betaRad) < 0.17 && Math.abs(input.r) < 0.5);
  state.departed = departed;

  const rawG =
    input.pitchStick >= 0
      ? 1 + input.pitchStick * (flcs.maxLoadFactor - 1)
      : 1 + input.pitchStick * (1 - flcs.minLoadFactor);
  state.commandedG = rawG;

  const liftArea = Math.max(input.dynamicPressurePa * geometry.wingAreaM2, 1);
  const clCommand = (rawG * input.massKg * GRAVITY_MPS2) / liftArea;
  const rawAlpha = alphaForLiftCoefficient(clCommand, aero) + state.alphaIntegralRad;
  const alphaCommand = clamp(
    rawAlpha,
    -flcs.alphaLimitRad * flcs.negativeAlphaLimitFraction,
    flcs.alphaLimitRad,
  );
  state.commandedAlphaRad = alphaCommand;
  const limiting = rawAlpha > flcs.alphaLimitRad;
  state.limiterActive = limiting;

  const achievableG = (liftCoefficientAt(alphaCommand, aero) * liftArea) / (input.massKg * GRAVITY_MPS2);
  const qSteady = (GRAVITY_MPS2 * (achievableG + input.gravityAlongBodyUp)) / speed;
  const qCommand = qSteady + flcs.alphaTrackingGain * (alphaCommand - input.alphaRad);

  if (!limiting && !departed) {
    state.alphaIntegralRad = clamp(
      state.alphaIntegralRad + flcs.alphaIntegralGain * (rawG - input.loadFactor) * dt * 0.01,
      -flcs.alphaIntegralLimitRad,
      flcs.alphaIntegralLimitRad,
    );
  } else {
    state.alphaIntegralRad *= Math.exp(-dt / 0.5);
  }

  const qHatCommand = (qCommand * geometry.meanChordM) / (2 * speed);
  const pitchTrim =
    -(aero.cmZero + aero.cmAlpha * input.alphaRad + aero.cmQ * qHatCommand) / aero.cmPitchCommand;
  state.pitchWashout += ((input.q - state.pitchWashout) * dt) / 1.2;
  const pitchFeedback =
    flcs.pitchRateGain * schedule * (qCommand - input.q) - flcs.pitchRateDamping * (input.q - state.pitchWashout);
  const pitchCommand = clamp(pitchTrim + pitchFeedback, -1, 1);

  const fade = clamp(
    1 - (0.65 * (Math.abs(input.alphaRad) - flcs.rollAlphaFadeStartRad)) / (flcs.alphaLimitRad - flcs.rollAlphaFadeStartRad),
    0.35,
    1,
  );
  const pCommand = input.rollStick * flcs.maxRollRateRadS * fade * (departed ? 0.3 : 1);
  const rollTrim =
    -(aero.clP * pCommand * halfSpan + aero.clBeta * input.betaRad + aero.clR * rHat) / aero.clRollCommand;
  const rollCommand = clamp(rollTrim + flcs.rollRateGain * schedule * (pCommand - input.p), -1, 1);

  state.yawWashout += ((input.r - state.yawWashout) * dt) / 1.5;
  const damped = input.r - state.yawWashout;
  const betaCommand = -input.yawPedal * flcs.maxCommandedSideslipRad;

  const yawTrim =
    -(aero.cnBeta * betaCommand + aero.cnP * pHat + aero.cnR * rHat + aero.cnRollCommand * rollCommand) /
    aero.cnYawCommand;
  const yawCommand = clamp(
    clamp(yawTrim, -1, 1) +
      flcs.sideslipGain * schedule * (input.betaRad - betaCommand) -
      flcs.yawDamperGain * schedule * damped,
    -1,
    1,
  );

  state.pitch = slew(state.pitch, pitchCommand, surfaces.elevatorRateRadS / surfaces.elevatorMaxRad, dt);
  state.roll = slew(state.roll, rollCommand, surfaces.aileronRateRadS / surfaces.aileronMaxRad, dt);
  state.yaw = slew(state.yaw, yawCommand, surfaces.rudderRateRadS / surfaces.rudderMaxRad, dt);
  return state;
}
