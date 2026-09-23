import { Vector3 } from "three";
import { GEOMETRY, type GeometrySpec } from "./config";
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

function hullRadius(volumes: readonly HitVolume[]): number {
  return volumes.reduce((max, volume) => Math.max(max, Math.hypot(...volume.offset) + volume.radiusM), 0);
}

export const HULL_RADIUS_M = hullRadius(HIT_VOLUMES);

const scaled = new WeakMap<GeometrySpec, { volumes: readonly HitVolume[]; hullRadiusM: number }>();

/**
 * The F-16's hit table stretched to another airframe: sideways by span,
 * fore and aft by length, and each sphere by the mean of the two. A Su-27
 * is a bigger target than an F-5 because it is bigger, not because of a
 * number picked for it.
 */
export function hitVolumesFor(geometry: GeometrySpec = GEOMETRY): { volumes: readonly HitVolume[]; hullRadiusM: number } {
  if (geometry === GEOMETRY) return { volumes: HIT_VOLUMES, hullRadiusM: HULL_RADIUS_M };
  const known = scaled.get(geometry);
  if (known) return known;
  const across = geometry.wingSpanM / GEOMETRY.wingSpanM;
  const along = geometry.lengthM / GEOMETRY.lengthM;
  const size = (across + along) / 2;
  const volumes = HIT_VOLUMES.map((volume) => ({
    ...volume,
    offset: [volume.offset[0] * across, volume.offset[1] * size, volume.offset[2] * along] as const,
    radiusM: volume.radiusM * size,
  }));
  const entry = { volumes, hullRadiusM: hullRadius(volumes) };
  scaled.set(geometry, entry);
  return entry;
}

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

/** `damageScale` is the round against a 20 mm one: a 30 mm shell does about twice the harm. */
export function applyHit(
  damage: DamageState,
  volume: HitVolume,
  energyFraction: number,
  roll: number,
  damageScale = 1,
): void {
  const scale = clamp(energyFraction, 0.25, 1) * damageScale;
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

/**
 * A blast-fragmentation warhead going off near the aeroplane.
 *
 * Each part of the airframe is hurt by how close the burst was to it, falling
 * away to nothing at the lethal radius and squared so that a near miss is much
 * worse than a far one. A burst inside a few metres takes the jet apart; one
 * at the edge of the fuze's reach cripples it.
 */
export function applyBlast(
  damage: DamageState,
  burst: Vector3,
  position: Vector3,
  right: Vector3,
  up: Vector3,
  nose: Vector3,
  lethalRadiusM: number,
  roll: number,
  volumes: readonly HitVolume[] = HIT_VOLUMES,
): number {
  const before = damage.integrity;
  let struck = false;
  for (const volume of volumes) {
    const centre = volumeCenter(volume, position, right, up, nose);
    const distance = Math.max(0, centre.distanceTo(burst) - volume.radiusM);
    const exposure = clamp(1 - distance / lethalRadiusM, 0, 1) ** 2;
    if (exposure <= 0) continue;
    struck = true;
    damage.integrity = Math.max(0, damage.integrity - 0.9 * exposure);
    damage.subsystems[volume.subsystem] = Math.max(0, damage.subsystems[volume.subsystem] - 1.5 * exposure);
    damage.fuelLeakKgS += volume.fuelLeakKgS * 3 * exposure;
    if (volume.pilotKillChance > 0 && roll < volume.pilotKillChance * 1.5 * exposure) {
      damage.pilotIncapacitated = true;
    }
  }
  if (struck) damage.hitsTaken += 1;
  return before - damage.integrity;
}
