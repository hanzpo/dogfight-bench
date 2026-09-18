import { densityRatio } from "./atmosphere";
import { ENGINE } from "./config";

export interface EngineState {
  power: number;
  fuelKg: number;
  thrustN: number;
  fuelFlowKgS: number;
  afterburner: boolean;
}

export function commandedPower(throttle: number): number {
  const t = Math.max(0, Math.min(1, throttle));
  if (t <= ENGINE.afterburnerThreshold) return t / ENGINE.afterburnerThreshold;
  return 1 + (t - ENGINE.afterburnerThreshold) / (1 - ENGINE.afterburnerThreshold);
}

export function thrustAtPower(power: number, altitudeM: number, mach: number): number {
  const sigma = densityRatio(altitudeM);
  const dry = Math.min(power, 1);
  const wet = Math.max(0, power - 1);

  const coreLapse = sigma ** 0.82 * (1 - 0.18 * mach + 0.16 * mach * mach);
  const burnerLapse = sigma ** 0.70 * (1 - 0.10 * mach + 0.34 * mach * mach);

  const idle = ENGINE.militaryThrustSlN * ENGINE.idleFraction * coreLapse;
  const military = ENGINE.militaryThrustSlN * coreLapse;
  const burnerDelta = (ENGINE.afterburnerThrustSlN - ENGINE.militaryThrustSlN) * burnerLapse;
  return (idle + (military - idle) * dry + burnerDelta * wet) * ENGINE.installationEfficiency;
}

export function stepEngine(engine: EngineState, throttle: number, altitudeM: number, mach: number, dt: number): void {
  const target = commandedPower(throttle);
  const spooling = target > engine.power;
  const inBurner = engine.power > 1 || target > 1;
  const tau = inBurner ? ENGINE.afterburnerTau : spooling ? ENGINE.spoolUpTau : ENGINE.spoolDownTau;
  engine.power += (target - engine.power) * (1 - Math.exp(-dt / tau));

  const dryFraction = Math.min(engine.power, 1);
  const wetFraction = Math.max(0, engine.power - 1);
  engine.afterburner = wetFraction > 0.02;

  if (engine.fuelKg <= 0) {
    engine.power = Math.max(0, engine.power - dt / ENGINE.spoolDownTau);
    engine.thrustN = 0;
    engine.fuelFlowKgS = 0;
    engine.fuelKg = 0;
    return;
  }

  engine.thrustN = thrustAtPower(engine.power, altitudeM, mach);
  const dryThrust = ENGINE.militaryThrustSlN * dryFraction;
  const wetThrust = (ENGINE.afterburnerThrustSlN - ENGINE.militaryThrustSlN) * wetFraction;
  engine.fuelFlowKgS = dryThrust * ENGINE.tsfcMilitary + wetThrust * ENGINE.tsfcAfterburner;
  engine.fuelKg = Math.max(0, engine.fuelKg - engine.fuelFlowKgS * dt);
}
