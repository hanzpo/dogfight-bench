import { Vector3 } from "three";
import type { DamageState, Subsystem } from "./types";
import { clamp } from "../math";

export interface HitVolume {
  subsystem: Subsystem;
  offset: readonly [number, number, number];
  radiusM: number;
  integrityLoss: number;
  subsystemLoss: number;
  fuelLeakKgS: number;
  pilotKillChance: number;
}

export const HIT_VOLUMES: readonly HitVolume[] = [
  {
    subsystem: "cockpit",
    offset: [0, 0.55, 3.2],
    radiusM: 1.05,
    integrityLoss: 0.2,
    subsystemLoss: 0.25,
    fuelLeakKgS: 0,
    pilotKillChance: 0.35,
  },
  {
    subsystem: "forward-fuselage",
    offset: [0, 0.15, 1.0],
    radiusM: 1.5,
    integrityLoss: 0.12,
    subsystemLoss: 0.18,
    fuelLeakKgS: 0.8,
    pilotKillChance: 0,
  },
  {
    subsystem: "left-wing",
    offset: [-2.9, -0.05, -0.6],
    radiusM: 1.7,
    integrityLoss: 0.08,
    subsystemLoss: 0.22,
    fuelLeakKgS: 0.6,
    pilotKillChance: 0,
  },
  {
    subsystem: "right-wing",
    offset: [2.9, -0.05, -0.6],
    radiusM: 1.7,
    integrityLoss: 0.08,
    subsystemLoss: 0.22,
    fuelLeakKgS: 0.6,
    pilotKillChance: 0,
  },
  {
    subsystem: "engine",
    offset: [0, 0, -4.2],
    radiusM: 1.35,
    integrityLoss: 0.16,
    subsystemLoss: 0.3,
    fuelLeakKgS: 0.4,
    pilotKillChance: 0,
  },
  {
    subsystem: "tail",
    offset: [0, 1.5, -5.3],
    radiusM: 1.3,
    integrityLoss: 0.09,
    subsystemLoss: 0.28,
    fuelLeakKgS: 0,
    pilotKillChance: 0,
  },
];

export const HULL_RADIUS_M = HIT_VOLUMES.reduce(
  (max, volume) => Math.max(max, Math.hypot(...volume.offset) + volume.radiusM),
  0,
);

export function createDamageState(): DamageState {
  return {
    integrity: 1,
    subsystems: {
      cockpit: 1,
      "forward-fuselage": 1,
      "left-wing": 1,
      "right-wing": 1,
      engine: 1,
      tail: 1,
    },
    fuelLeakKgS: 0,
    pilotIncapacitated: false,
    hitsTaken: 0,
  };
}

export function volumeCenter(
  volume: HitVolume,
  position: Vector3,
  right: Vector3,
  up: Vector3,
  nose: Vector3,
): Vector3 {
  return position
    .clone()
    .addScaledVector(right, volume.offset[0])
    .addScaledVector(up, volume.offset[1])
    .addScaledVector(nose, volume.offset[2]);
}

export function applyHit(damage: DamageState, volume: HitVolume, energyFraction: number, roll: number): void {
  const scale = clamp(energyFraction, 0.25, 1);
  damage.hitsTaken += 1;
  damage.integrity = Math.max(0, damage.integrity - volume.integrityLoss * scale);
  damage.subsystems[volume.subsystem] = Math.max(
    0,
    damage.subsystems[volume.subsystem] - volume.subsystemLoss * scale,
  );
  damage.fuelLeakKgS += volume.fuelLeakKgS * scale;
  if (volume.pilotKillChance > 0 && roll < volume.pilotKillChance * scale) {
    damage.pilotIncapacitated = true;
  }
}

export function isDestroyed(damage: DamageState): boolean {
  return (
    damage.integrity <= 0 ||
    damage.pilotIncapacitated ||
    (damage.subsystems["left-wing"] <= 0 && damage.subsystems["right-wing"] <= 0)
  );
}
