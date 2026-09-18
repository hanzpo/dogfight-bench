import { GRAVITY_MPS2 } from "./atmosphere";
import { alphaForLiftCoefficient, liftCoefficient as liftCoefficientAt } from "./aero";
import { AERO, FLCS, GEOMETRY, SURFACES } from "./config";

/**
 * A simplified F-16 flight-control system.
 *
 * The pilot (human or model) never commands surfaces directly. Longitudinal
 * stick is a g-command, lateral stick is a roll-rate command, and the pedals
 * command sideslip; the FLCS resolves those into normalised command-axis
 * deflections, gain-scheduled on dynamic pressure, with an angle-of-attack
 * limiter and a yaw damper on top. This is what makes the jet feel carefree and
 * what makes a 4 Hz model able to fly it at all.
 */

export interface FlcsState {
  /** Normalised command-axis deflections currently held by the actuators. */
  pitch: number;
  roll: number;
  yaw: number;
  /** Washed-out pitch and yaw rates used by the dampers, rad/s. */
  pitchWashout: number;
  /** Integrated load-factor error, expressed as an angle-of-attack bias. */
  alphaIntegralRad: number;
  /** Angle of attack the laws are currently asking for, radians. */
  commandedAlphaRad: number;
  yawWashout: number;
  /** True while the jet is outside the limiter's authority. */
  departed: boolean;
  /** Load factor the laws are currently commanding. */
  commandedG: number;
  /** True while the alpha limiter is holding the pull back. */
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
  /** Pilot axes, -1..1 (pitch positive = pull). */
  pitchStick: number;
  rollStick: number;
  yawPedal: number;
  alphaRad: number;
  betaRad: number;
  /** Aero body rates, rad/s. */
  p: number;
  q: number;
  r: number;
  trueAirspeedMps: number;
  dynamicPressurePa: number;
  /** Load factor measured last tick, used to close the outer loop. */
  loadFactor: number;
  massKg: number;
  /** Component of the gravity unit vector along the body "up" axis. */
  gravityAlongBodyUp: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Moves an actuator toward its command under a normalised rate limit. */
function slew(current: number, command: number, maxRatePerSecond: number, dt: number): number {
  const limit = maxRatePerSecond * dt;
  return current + clamp(command - current, -limit, limit);
}

/**
 * Gain schedule. Control power scales with dynamic pressure, so the loop gains
 * scale inversely to keep closed-loop response roughly constant.
 */
export function gainSchedule(dynamicPressurePa: number): number {
  return clamp(FLCS.referenceQ / Math.max(dynamicPressurePa, FLCS.minGainScheduleQ), 0.25, 2.5);
}

/** Load factor available at a given dynamic pressure without exceeding the alpha limit. */
export function limiterLoadFactor(dynamicPressurePa: number, massKg: number): number {
  const lift = liftCoefficientAt(FLCS.alphaLimitRad) * dynamicPressurePa * GEOMETRY.wingAreaM2;
  return Math.min(FLCS.maxLoadFactor, lift / (massKg * GRAVITY_MPS2));
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

  // --- Longitudinal: g command resolved through an alpha command ------------
  const rawG =
    input.pitchStick >= 0
      ? 1 + input.pitchStick * (FLCS.maxLoadFactor - 1)
      : 1 + input.pitchStick * (1 - FLCS.minLoadFactor);
  state.commandedG = rawG;

  // Angle of attack that would produce the commanded load factor here. Clamping
  // it is the limiter: the jet is never asked for lift it cannot make.
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

  // Load factor actually available at the clamped alpha, which sets the
  // steady-state pitch rate the turn needs.
  const achievableG = (liftCoefficientAt(alphaCommand) * liftArea) / (input.massKg * GRAVITY_MPS2);
  const qSteady = (GRAVITY_MPS2 * (achievableG + input.gravityAlongBodyUp)) / speed;
  const qCommand = qSteady + FLCS.alphaTrackingGain * (alphaCommand - input.alphaRad);

  // The integrator trims out modelling error in the alpha-for-g inversion, and
  // is frozen while the limiter owns the command so it cannot wind up.
  if (!limiting && !departed) {
    state.alphaIntegralRad = clamp(
      state.alphaIntegralRad + FLCS.alphaIntegralGain * (rawG - input.loadFactor) * dt * 0.01,
      -FLCS.alphaIntegralLimitRad,
      FLCS.alphaIntegralLimitRad,
    );
  } else {
    state.alphaIntegralRad *= Math.exp(-dt / 0.5);
  }

  // Feed-forward cancels the airframe's own pitching moment, including the
  // damping the commanded rate will provoke, so the inner loop only has to
  // correct what the model gets wrong.
  const qHatCommand = (qCommand * GEOMETRY.meanChordM) / (2 * speed);
  const pitchTrim =
    -(AERO.cmZero + AERO.cmAlpha * input.alphaRad + AERO.cmQ * qHatCommand) / AERO.cmPitchCommand;
  state.pitchWashout += ((input.q - state.pitchWashout) * dt) / 1.2;
  const pitchFeedback =
    FLCS.pitchRateGain * schedule * (qCommand - input.q) - FLCS.pitchRateDamping * (input.q - state.pitchWashout);
  const pitchCommand = clamp(pitchTrim + pitchFeedback, -1, 1);

  // --- Lateral: roll-rate command, faded out by the alpha limiter ----------
  const fade = clamp(
    1 - (0.65 * (Math.abs(input.alphaRad) - FLCS.rollAlphaFadeStartRad)) / (FLCS.alphaLimitRad - FLCS.rollAlphaFadeStartRad),
    0.35,
    1,
  );
  const pCommand = input.rollStick * FLCS.maxRollRateRadS * fade * (departed ? 0.3 : 1);
  const rollTrim =
    -(AERO.clP * pCommand * halfSpan + AERO.clBeta * input.betaRad + AERO.clR * rHat) / AERO.clRollCommand;
  const rollCommand = clamp(rollTrim + FLCS.rollRateGain * schedule * (pCommand - input.p), -1, 1);

  // --- Directional: sideslip command plus a washed-out yaw damper ----------
  state.yawWashout += ((input.r - state.yawWashout) * dt) / 1.5;
  const damped = input.r - state.yawWashout;
  // Positive pedal yaws the nose right, which puts the relative wind on the
  // left and therefore makes sideslip negative.
  const betaCommand = -input.yawPedal * FLCS.maxCommandedSideslipRad;

  // The feed-forward holds the commanded sideslip against weathercock
  // stability, cancels the yaw rate a coordinated turn needs, and cancels the
  // adverse yaw the roll channel is about to produce -- that last term is the
  // aileron-rudder interconnect, so it does not need one of its own.
  const yawTrim =
    -(AERO.cnBeta * betaCommand + AERO.cnP * pHat + AERO.cnR * rHat + AERO.cnRollCommand * rollCommand) /
    AERO.cnYawCommand;
  const yawCommand = clamp(
    clamp(yawTrim, -1, 1) +
      // Too much positive sideslip means the nose is left of the wind, so the
      // correction is nose-right: the error term is (beta - command), not the
      // other way round.
      FLCS.sideslipGain * schedule * (input.betaRad - betaCommand) -
      FLCS.yawDamperGain * schedule * damped,
    -1,
    1,
  );

  // Actuators cannot step instantly; rate limiting also keeps the 120 Hz loop
  // from chattering when the feedback gains saturate.
  state.pitch = slew(state.pitch, pitchCommand, SURFACES.elevatorRateRadS / SURFACES.elevatorMaxRad, dt);
  state.roll = slew(state.roll, rollCommand, SURFACES.aileronRateRadS / SURFACES.aileronMaxRad, dt);
  state.yaw = slew(state.yaw, yawCommand, SURFACES.rudderRateRadS / SURFACES.rudderMaxRad, dt);
  return state;
}
