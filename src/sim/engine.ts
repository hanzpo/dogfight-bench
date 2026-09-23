import { densityRatio } from "./atmosphere";
import { ENGINE, type EngineSpec } from "./config";
import { clamp } from "../math";

export interface EngineState {
  power: number;
  fuelKg: number;
  thrustN: number;
  fuelFlowKgS: number;
  afterburner: boolean;
}

export function commandedPower(throttle: number, spec: EngineSpec = ENGINE): number {
  const t = clamp(throttle, 0, 1);
  if (t <= spec.afterburnerThreshold) return t / spec.afterburnerThreshold;
  return 1 + (t - spec.afterburnerThreshold) / (1 - spec.afterburnerThreshold);
}

export function thrustAtPower(power: number, altitudeM: number, mach: number, spec: EngineSpec = ENGINE): number {
  const sigma = densityRatio(altitudeM);
  const dry = Math.min(power, 1);
  const wet = Math.max(0, power - 1);

  const coreLapse = sigma ** 0.82 * (1 - 0.18 * mach + 0.16 * mach * mach);
  const burnerLapse = sigma ** 0.70 * (1 - 0.10 * mach + 0.34 * mach * mach);

  const idle = spec.militaryThrustSlN * spec.idleFraction * coreLapse;
  const military = spec.militaryThrustSlN * coreLapse;
  const burnerDelta = (spec.afterburnerThrustSlN - spec.militaryThrustSlN) * burnerLapse;
  return (idle + (military - idle) * dry + burnerDelta * wet) * spec.installationEfficiency;
}

export function stepEngine(
  engine: EngineState,
  throttle: number,
  altitudeM: number,
  mach: number,
  dt: number,
  spec: EngineSpec = ENGINE,
): void {
  const target = commandedPower(throttle, spec);
  const spooling = target > engine.power;
  const inBurner = engine.power > 1 || target > 1;
  const tau = inBurner ? spec.afterburnerTau : spooling ? spec.spoolUpTau : spec.spoolDownTau;
  engine.power += (target - engine.power) * (1 - Math.exp(-dt / tau));

  const dryFraction = Math.min(engine.power, 1);
  const wetFraction = Math.max(0, engine.power - 1);
  engine.afterburner = wetFraction > 0.02;

  if (engine.fuelKg <= 0) {
    engine.power = Math.max(0, engine.power - dt / spec.spoolDownTau);
    engine.thrustN = 0;
    engine.fuelFlowKgS = 0;
    engine.fuelKg = 0;
    return;
  }

  engine.thrustN = thrustAtPower(engine.power, altitudeM, mach, spec);
  const dryThrust = spec.militaryThrustSlN * dryFraction;
  const wetThrust = (spec.afterburnerThrustSlN - spec.militaryThrustSlN) * wetFraction;
  engine.fuelFlowKgS = dryThrust * spec.tsfcMilitary + wetThrust * spec.tsfcAfterburner;
  engine.fuelKg = Math.max(0, engine.fuelKg - engine.fuelFlowKgS * dt);
}
