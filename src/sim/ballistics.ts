import { SEA_LEVEL_DENSITY } from "./atmosphere";
import { GUN, type GunSpec } from "./config";

const G1_MACH = [
  0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.825, 0.85, 0.875, 0.9, 0.925, 0.95, 0.975, 1.0, 1.025, 1.05,
  1.075, 1.1, 1.125, 1.15, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 3.0, 3.6, 4.0, 5.0,
];
const G1_CD = [
  0.2629, 0.2558, 0.2487, 0.2413, 0.2344, 0.2278, 0.2217, 0.2155, 0.2104, 0.2278, 0.2451, 0.2685, 0.2955, 0.326,
  0.3566, 0.388, 0.4196, 0.4478, 0.4744, 0.4978, 0.5152, 0.527, 0.5341, 0.5376, 0.5386, 0.5354, 0.5285, 0.5187,
  0.5081, 0.487, 0.4673, 0.4492, 0.4328, 0.4178, 0.3923, 0.3632, 0.3474, 0.3194,
];

export function g1DragCoefficient(mach: number): number {
  if (mach <= G1_MACH[0]!) return G1_CD[0]!;
  const last = G1_MACH.length - 1;
  if (mach >= G1_MACH[last]!) return G1_CD[last]!;
  let index = 1;
  while (G1_MACH[index]! < mach) index += 1;
  const lo = G1_MACH[index - 1]!;
  const hi = G1_MACH[index]!;
  const t = (mach - lo) / (hi - lo);
  return G1_CD[index - 1]! * (1 - t) + G1_CD[index]! * t;
}

export function projectileArea(gun: GunSpec = GUN): number {
  return Math.PI * (gun.projectileDiameterM / 2) ** 2;
}

export function formFactor(gun: GunSpec = GUN): number {
  return gun.projectileMassKg / gun.projectileDiameterM ** 2 / (gun.ballisticCoefficientG1 * 703.069);
}

export const PROJECTILE_AREA_M2 = projectileArea();

export const FORM_FACTOR = formFactor();

export function projectileDragCoefficient(mach: number, gun: GunSpec = GUN): number {
  return g1DragCoefficient(mach) * formFactor(gun);
}

export function projectileDeceleration(
  speed: number,
  density: number,
  speedOfSoundMps: number,
  gun: GunSpec = GUN,
): number {
  const cd = projectileDragCoefficient(speed / speedOfSoundMps, gun);
  return (0.5 * density * speed * speed * cd * projectileArea(gun)) / gun.projectileMassKg;
}

export function timeOfFlight(
  rangeM: number,
  muzzleSpeedMps: number,
  density: number,
  speedOfSoundMps: number,
  gun: GunSpec = GUN,
): { seconds: number; impactSpeedMps: number } {
  const speed = Math.max(muzzleSpeedMps, 1);
  const range = Math.max(rangeM, 0);
  const constantAt = (reference: number) =>
    projectileDeceleration(reference, density, speedOfSoundMps, gun) / (reference * reference);

  let k = constantAt(speed);
  if (k <= 0) return { seconds: range / speed, impactSpeedMps: speed };
  const roughImpact = speed / Math.exp(k * range);
  k = constantAt(Math.max((speed + roughImpact) / 2, 1));

  const growth = Math.exp(k * range);
  return { seconds: (growth - 1) / (k * speed), impactSpeedMps: speed / growth };
}

export function kineticEnergyJ(speed: number, gun: GunSpec = GUN): number {
  return 0.5 * gun.projectileMassKg * speed * speed;
}
