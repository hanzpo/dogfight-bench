import { Quaternion, Vector3 } from "three";
import { coefficients, momentCoefficients } from "./aero";
import { GRAVITY_MPS2, atmosphere } from "./atmosphere";
import { AERO, GEOMETRY, MASS } from "./config";
import { stepEngine } from "./engine";
import { stepFlcs } from "./flcs";
import { heightAboveGround } from "./terrain";
import type { AircraftState, ControlInput } from "./types";
import { clamp } from "../math";

const BODY_X = new Vector3(1, 0, 0);
const BODY_Y = new Vector3(0, 1, 0);
const BODY_Z = new Vector3(0, 0, 1);
const WORLD_DOWN = new Vector3(0, -1, 0);

export function sanitizeControls(input: ControlInput): ControlInput {
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  return {
    pitch: clamp(finite(input.pitch, 0), -1, 1),
    roll: clamp(finite(input.roll, 0), -1, 1),
    yaw: clamp(finite(input.yaw, 0), -1, 1),
    throttle: clamp(finite(input.throttle, 0), 0, 1),
    fire: input.fire === true,
    missile: input.missile === true,
    flare: input.flare === true,
  };
}

export { airDensity, speedOfSound } from "./atmosphere";

export function currentMass(aircraft: AircraftState): number {
  return MASS.emptyKg + aircraft.engine.fuelKg;
}

export function inertia(fuelKg: number): { ixx: number; iyy: number; izz: number; ixz: number } {
  const fill = clamp(fuelKg / MASS.internalFuelKg, 0, 1);
  const scale = 1 - MASS.fuelInertiaFraction * (1 - fill);
  return {
    ixx: MASS.ixxKgM2 * scale,
    iyy: MASS.iyyKgM2 * scale,
    izz: MASS.izzKgM2 * scale,
    ixz: MASS.ixzKgM2 * scale,
  };
}

export interface BodyAxes {
  nose: Vector3;
  right: Vector3;
  down: Vector3;
  up: Vector3;
}

export function bodyAxes(orientation: Quaternion): BodyAxes {
  const nose = BODY_Z.clone().applyQuaternion(orientation);
  const up = BODY_Y.clone().applyQuaternion(orientation);
  const left = BODY_X.clone().applyQuaternion(orientation);
  return { nose, right: left.clone().negate(), down: up.clone().negate(), up };
}

export function aeroRatesToRotationVector(p: number, q: number, r: number): Vector3 {
  return new Vector3(-q, -r, p);
}

/**
 * How fast the stick and throttle can be moved, in full deflections a second.
 *
 * A fighter pilot can slam the stick corner to corner in about a fifth of a
 * second, and no faster. The throttle is a lever with a hand on it and moves
 * slower still; the engine's own spool-up is modelled separately.
 */
const STICK_PER_SECOND = 5;
const THROTTLE_PER_SECOND = 2;

function towards(current: number, wanted: number, limit: number): number {
  return current + clamp(wanted - current, -limit, limit);
}

/** Moves the controls towards what was commanded, as fast as a hand can. */
export function trackCommandedControls(aircraft: AircraftState, dt: number): void {
  const wanted = sanitizeControls(aircraft.commandedControls);
  const stick = STICK_PER_SECOND * dt;
  aircraft.controls = {
    pitch: towards(aircraft.controls.pitch, wanted.pitch, stick),
    roll: towards(aircraft.controls.roll, wanted.roll, stick),
    yaw: towards(aircraft.controls.yaw, wanted.yaw, stick),
    throttle: towards(aircraft.controls.throttle, wanted.throttle, THROTTLE_PER_SECOND * dt),
    // The trigger is a switch, not a lever.
    fire: wanted.fire,
    missile: wanted.missile,
    flare: wanted.flare,
  };
}

export function stepAircraft(aircraft: AircraftState, dt: number): void {
  if (!aircraft.alive) return;

  trackCommandedControls(aircraft, dt);
  const controls = aircraft.controls;

  const axes = bodyAxes(aircraft.orientation);
  const agl = heightAboveGround(aircraft.position.x, aircraft.position.y, aircraft.position.z);
  aircraft.heightAboveGroundM = agl;
  const air = atmosphere(aircraft.position.y);

  const speed = aircraft.velocity.length();
  const vTrue = Math.max(speed, 1e-3);
  const u = aircraft.velocity.dot(axes.nose);
  const v = aircraft.velocity.dot(axes.right);
  const w = aircraft.velocity.dot(axes.down);
  const alpha = Math.atan2(w, Math.abs(u) < 1e-3 ? 1e-3 : u);
  const beta = Math.asin(clamp(v / vTrue, -1, 1));
  aircraft.aoaRad = alpha;
  aircraft.sideslipRad = beta;
  aircraft.mach = vTrue / air.speedOfSoundMps;
  const qbar = 0.5 * air.densityKgM3 * vTrue * vTrue;

  const p = aircraft.angularVelocity.x;
  const q = aircraft.angularVelocity.y;
  const r = aircraft.angularVelocity.z;

  const controlHealth = clamp(
    0.35 + 0.65 * Math.min(aircraft.damage.subsystems.tail, aircraft.damage.subsystems["forward-fuselage"]),
    0.2,
    1,
  );
  stepFlcs(
    aircraft.flcs,
    {
      pitchStick: controls.pitch,
      rollStick: controls.roll,
      yawPedal: controls.yaw,
      alphaRad: alpha,
      betaRad: beta,
      p,
      q,
      r,
      trueAirspeedMps: vTrue,
      dynamicPressurePa: qbar,
      loadFactor: aircraft.loadFactor,
      massKg: aircraft.massKg,
      gravityAlongBodyUp: WORLD_DOWN.dot(axes.up),
    },
    dt,
  );

  stepEngine(aircraft.engine, controls.throttle, aircraft.position.y, aircraft.mach, dt);
  aircraft.engine.fuelKg = Math.max(0, aircraft.engine.fuelKg - aircraft.damage.fuelLeakKgS * dt);
  const thrustN = aircraft.engine.thrustN * aircraft.damage.subsystems.engine;
  aircraft.massKg = currentMass(aircraft);

  const wingHealth = 0.5 * (aircraft.damage.subsystems["left-wing"] + aircraft.damage.subsystems["right-wing"]);
  const aero = coefficients(alpha, beta, aircraft.mach, agl);
  const cl = aero.cl * (0.55 + 0.45 * wingHealth);
  const cd = aero.cd + (1 - wingHealth) * 0.05;
  const scale = qbar * GEOMETRY.wingAreaM2;
  const lift = scale * cl;
  const drag = scale * cd;
  const side = scale * aero.cy;

  const sa = Math.sin(alpha);
  const ca = Math.cos(alpha);
  const sb = Math.sin(beta);
  const cb = Math.cos(beta);
  const forceNose = -drag * ca * cb - side * ca * sb + lift * sa;
  const forceRight = -drag * sb + side * cb;
  const forceDown = -drag * sa * cb - side * sa * sb - lift * ca;

  const aeroForce = axes.nose
    .clone()
    .multiplyScalar(forceNose)
    .addScaledVector(axes.right, forceRight)
    .addScaledVector(axes.down, forceDown);
  const thrustForce = axes.nose.clone().multiplyScalar(thrustN);
  const specificForce = aeroForce.clone().add(thrustForce).multiplyScalar(1 / aircraft.massKg);

  aircraft.loadFactor = specificForce.dot(axes.up) / GRAVITY_MPS2;
  aircraft.specificExcessPowerMps = (vTrue * (thrustN - drag)) / (aircraft.massKg * GRAVITY_MPS2);

  const acceleration = specificForce.clone().add(new Vector3(0, -GRAVITY_MPS2, 0));
  aircraft.acceleration.copy(acceleration);

  const halfSpan = GEOMETRY.wingSpanM / (2 * vTrue);
  const halfChord = GEOMETRY.meanChordM / (2 * vTrue);
  const moments = momentCoefficients(
    alpha,
    beta,
    p * halfSpan,
    q * halfChord,
    r * halfSpan,
    aircraft.flcs.pitch * controlHealth,
    aircraft.flcs.roll * controlHealth,
    aircraft.flcs.yaw * controlHealth,
    aircraft.flcs.departed,
  );
  const asymmetricRoll =
    (aircraft.damage.subsystems["right-wing"] - aircraft.damage.subsystems["left-wing"]) * 0.045;

  const rollMoment = scale * GEOMETRY.wingSpanM * (moments.roll + asymmetricRoll);
  const pitchMoment = scale * GEOMETRY.meanChordM * moments.pitch;
  const yawMoment = scale * GEOMETRY.wingSpanM * moments.yaw;

  const { ixx, iyy, izz, ixz } = inertia(aircraft.engine.fuelKg);
  const gamma = ixx * izz - ixz * ixz;
  const a = rollMoment - (izz - iyy) * q * r + ixz * p * q;
  const b = yawMoment - (iyy - ixx) * p * q - ixz * q * r;
  const pDot = (izz * a + ixz * b) / gamma;
  const rDot = (ixz * a + ixx * b) / gamma;
  const qDot = (pitchMoment - (ixx - izz) * p * r - ixz * (p * p - r * r)) / iyy;

  aircraft.angularVelocity.set(p + pDot * dt, q + qDot * dt, r + rDot * dt);

  const omega = aeroRatesToRotationVector(
    aircraft.angularVelocity.x,
    aircraft.angularVelocity.y,
    aircraft.angularVelocity.z,
  );
  const angle = omega.length() * dt;
  if (angle > 1e-12) {
    const delta = new Quaternion().setFromAxisAngle(omega.normalize(), angle);
    aircraft.orientation.multiply(delta).normalize();
  }

  aircraft.velocity.addScaledVector(acceleration, dt);
  aircraft.position.addScaledVector(aircraft.velocity, dt);
}

export function availableLoadFactor(aircraft: AircraftState): number {
  const air = atmosphere(aircraft.position.y);
  const qbar = 0.5 * air.densityKgM3 * aircraft.velocity.lengthSq();
  const maxLift = qbar * GEOMETRY.wingAreaM2 * AERO.clMax;
  return Math.min(9, maxLift / (aircraft.massKg * GRAVITY_MPS2));
}
