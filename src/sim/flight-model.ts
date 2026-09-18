import { Quaternion, Vector3 } from "three";
import { F16 } from "./config";
import type { AircraftState, ControlInput } from "./types";

const BODY_RIGHT = new Vector3(1, 0, 0);
const BODY_UP = new Vector3(0, 1, 0);
const BODY_FORWARD = new Vector3(0, 0, 1);
const GRAVITY = new Vector3(0, -9.80665, 0);

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sanitizeControls(input: ControlInput): ControlInput {
  return {
    pitch: clamp(Number.isFinite(input.pitch) ? input.pitch : 0, -1, 1),
    roll: clamp(Number.isFinite(input.roll) ? input.roll : 0, -1, 1),
    yaw: clamp(Number.isFinite(input.yaw) ? input.yaw : 0, -1, 1),
    throttle: clamp(Number.isFinite(input.throttle) ? input.throttle : 0, 0, 1),
    fire: input.fire === true,
  };
}

export function airDensity(altitudeM: number): number {
  return 1.225 * Math.exp(-Math.max(altitudeM, 0) / 8_500);
}

export function speedOfSound(altitudeM: number): number {
  return Math.max(295, 340.3 - 0.003 * Math.max(altitudeM, 0));
}

export function stepAircraft(aircraft: AircraftState, dt: number): void {
  if (!aircraft.alive) return;

  const controls = sanitizeControls(aircraft.controls);
  aircraft.controls = controls;
  const inv = aircraft.orientation.clone().invert();
  const bodyVelocity = aircraft.velocity.clone().applyQuaternion(inv);
  const speed = Math.max(aircraft.velocity.length(), 1);
  aircraft.aoaRad = Math.atan2(-bodyVelocity.y, Math.max(bodyVelocity.z, 0.1));
  aircraft.sideslipRad = Math.atan2(bodyVelocity.x, Math.max(bodyVelocity.z, 0.1));

  const rho = airDensity(aircraft.position.y);
  const qbar = 0.5 * rho * speed * speed;
  const controlAuthority = clamp(qbar / 12_000, 0.12, 1);
  const aoaLimiter = clamp((F16.maxAoARad - Math.abs(aircraft.aoaRad)) / 0.12, 0.1, 1);
  const targetRates = new Vector3(
    controls.pitch * F16.maxPitchRate * controlAuthority * aoaLimiter,
    controls.yaw * F16.maxYawRate * controlAuthority,
    -controls.roll * F16.maxRollRate * controlAuthority,
  );
  const rateResponse = 1 - Math.exp(-dt * 5.5);
  aircraft.angularVelocity.lerp(targetRates, rateResponse);

  const omega = aircraft.angularVelocity;
  const angle = omega.length() * dt;
  if (angle > 1e-9) {
    const dq = new Quaternion().setFromAxisAngle(omega.clone().normalize(), angle);
    aircraft.orientation.multiply(dq).normalize();
  }

  const right = BODY_RIGHT.clone().applyQuaternion(aircraft.orientation);
  const up = BODY_UP.clone().applyQuaternion(aircraft.orientation);
  const forward = BODY_FORWARD.clone().applyQuaternion(aircraft.orientation);
  const alpha = aircraft.aoaRad;
  const stallRatio = Math.abs(alpha) / F16.maxAoARad;
  const stallFactor = stallRatio <= 1 ? 1 : Math.max(0.22, 1 - (stallRatio - 1) * 1.8);
  const cl = clamp(0.18 + 4.2 * alpha, -1.1, 1.55) * stallFactor;
  const cd = 0.022 + 0.085 * cl * cl + (stallRatio > 1 ? 0.35 * (stallRatio - 1) : 0);
  const liftN = qbar * F16.wingAreaM2 * cl;
  const dragN = qbar * F16.wingAreaM2 * cd;
  const sideN = -qbar * F16.wingAreaM2 * 0.55 * aircraft.sideslipRad;

  const throttle = controls.throttle;
  const dryFraction = Math.min(throttle / 0.85, 1);
  const burnerFraction = throttle > 0.85 ? (throttle - 0.85) / 0.15 : 0;
  const thrustN = F16.maxThrustN * dryFraction
    + (F16.afterburnerThrustN - F16.maxThrustN) * burnerFraction;

  const force = forward.multiplyScalar(thrustN)
    .add(up.multiplyScalar(liftN))
    .add(right.multiplyScalar(sideN))
    .add(aircraft.velocity.clone().normalize().multiplyScalar(-dragN));
  const acceleration = force.multiplyScalar(1 / F16.massKg).add(GRAVITY);
  aircraft.loadFactor = Math.abs(liftN) / (F16.massKg * 9.80665);
  aircraft.velocity.addScaledVector(acceleration, dt);
  aircraft.position.addScaledVector(aircraft.velocity, dt);
}
