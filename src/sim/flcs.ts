import { GRAVITY_MPS2 } from "./atmosphere";
import { alphaForLiftCoefficient, liftCoefficient as liftCoefficientAt } from "./aero";
import { AERO, FLCS, GEOMETRY, SURFACES } from "./config";
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

export function gainSchedule(dynamicPressurePa: number): number {
  return clamp(FLCS.referenceQ / Math.max(dynamicPressurePa, FLCS.minGainScheduleQ), 0.25, 2.5);
}

export function stepFlcs(state: FlcsState, input: FlcsInputs, dt: number): FlcsState {
  const schedule = gainSchedule(input.dynamicPressurePa);
  const speed = Math.max(input.trueAirspeedMps, 30);
  const halfSpan = GEOMETRY.wingSpanM / (2 * speed);
  const pHat = input.p * halfSpan;
  const rHat = input.r * halfSpan;

  const departed =
    Math.abs(input.alphaRad) > AERO.alphaDepartureRad || Math.abs(input.betaRad) > AERO.betaDepartureRad
      ? true
      : state.departed &&
        !(Math.abs(input.alphaRad) < 0.35 && Math.abs(input.betaRad) < 0.17 && Math.abs(input.r) < 0.5);
  state.departed = departed;

  const rawG =
    input.pitchStick >= 0
      ? 1 + input.pitchStick * (FLCS.maxLoadFactor - 1)
      : 1 + input.pitchStick * (1 - FLCS.minLoadFactor);
  state.commandedG = rawG;

  const liftArea = Math.max(input.dynamicPressurePa * GEOMETRY.wingAreaM2, 1);
  const clCommand = (rawG * input.massKg * GRAVITY_MPS2) / liftArea;
  const rawAlpha = alphaForLiftCoefficient(clCommand) + state.alphaIntegralRad;
  const alphaCommand = clamp(
    rawAlpha,
    -FLCS.alphaLimitRad * FLCS.negativeAlphaLimitFraction,
    FLCS.alphaLimitRad,
  );
  state.commandedAlphaRad = alphaCommand;
  const limiting = rawAlpha > FLCS.alphaLimitRad;
  state.limiterActive = limiting;

  const achievableG = (liftCoefficientAt(alphaCommand) * liftArea) / (input.massKg * GRAVITY_MPS2);
  const qSteady = (GRAVITY_MPS2 * (achievableG + input.gravityAlongBodyUp)) / speed;
  const qCommand = qSteady + FLCS.alphaTrackingGain * (alphaCommand - input.alphaRad);

  if (!limiting && !departed) {
    state.alphaIntegralRad = clamp(
      state.alphaIntegralRad + FLCS.alphaIntegralGain * (rawG - input.loadFactor) * dt * 0.01,
      -FLCS.alphaIntegralLimitRad,
      FLCS.alphaIntegralLimitRad,
    );
  } else {
    state.alphaIntegralRad *= Math.exp(-dt / 0.5);
  }

  const qHatCommand = (qCommand * GEOMETRY.meanChordM) / (2 * speed);
  const pitchTrim =
    -(AERO.cmZero + AERO.cmAlpha * input.alphaRad + AERO.cmQ * qHatCommand) / AERO.cmPitchCommand;
  state.pitchWashout += ((input.q - state.pitchWashout) * dt) / 1.2;
  const pitchFeedback =
    FLCS.pitchRateGain * schedule * (qCommand - input.q) - FLCS.pitchRateDamping * (input.q - state.pitchWashout);
  const pitchCommand = clamp(pitchTrim + pitchFeedback, -1, 1);

  const fade = clamp(
    1 - (0.65 * (Math.abs(input.alphaRad) - FLCS.rollAlphaFadeStartRad)) / (FLCS.alphaLimitRad - FLCS.rollAlphaFadeStartRad),
    0.35,
    1,
  );
  const pCommand = input.rollStick * FLCS.maxRollRateRadS * fade * (departed ? 0.3 : 1);
  const rollTrim =
    -(AERO.clP * pCommand * halfSpan + AERO.clBeta * input.betaRad + AERO.clR * rHat) / AERO.clRollCommand;
  const rollCommand = clamp(rollTrim + FLCS.rollRateGain * schedule * (pCommand - input.p), -1, 1);

  state.yawWashout += ((input.r - state.yawWashout) * dt) / 1.5;
  const damped = input.r - state.yawWashout;
  const betaCommand = -input.yawPedal * FLCS.maxCommandedSideslipRad;

  const yawTrim =
    -(AERO.cnBeta * betaCommand + AERO.cnP * pHat + AERO.cnR * rHat + AERO.cnRollCommand * rollCommand) /
    AERO.cnYawCommand;
  const yawCommand = clamp(
    clamp(yawTrim, -1, 1) +
      FLCS.sideslipGain * schedule * (input.betaRad - betaCommand) -
      FLCS.yawDamperGain * schedule * damped,
    -1,
    1,
  );

  state.pitch = slew(state.pitch, pitchCommand, SURFACES.elevatorRateRadS / SURFACES.elevatorMaxRad, dt);
  state.roll = slew(state.roll, rollCommand, SURFACES.aileronRateRadS / SURFACES.aileronMaxRad, dt);
  state.yaw = slew(state.yaw, yawCommand, SURFACES.rudderRateRadS / SURFACES.rudderMaxRad, dt);
  return state;
}
