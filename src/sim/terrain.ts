/**
 * Deterministic analytic terrain shared by the simulation and the renderer, so
 * that what the physics treats as ground is exactly what the viewer draws.
 */

export const TERRAIN_EXTENT_M = 80_000;

/** Terrain elevation in metres above the scenario's sea-level datum. */
export function terrainHeight(x: number, z: number): number {
  const basin = Math.min(1, Math.hypot(x, z) / 9_000);
  const ridges = Math.sin(x / 2_900) * Math.cos(z / 3_700) * 420 + Math.sin((x + z) / 1_450) * 130;
  const roll = Math.sin(x / 11_000 + 1.7) * Math.cos(z / 9_300 - 0.4) * 260;
  return Math.max(0, (ridges + roll) * basin);
}

/** Upward terrain normal, used for impact geometry and for lighting the mesh. */
export function terrainNormal(x: number, z: number, epsilon = 25): [number, number, number] {
  const dx = (terrainHeight(x + epsilon, z) - terrainHeight(x - epsilon, z)) / (2 * epsilon);
  const dz = (terrainHeight(x, z + epsilon) - terrainHeight(x, z - epsilon)) / (2 * epsilon);
  const length = Math.hypot(dx, 1, dz);
  return [-dx / length, 1 / length, -dz / length];
}

/** Height above terrain; negative once the aircraft is inside the ground. */
export function heightAboveGround(x: number, y: number, z: number): number {
  return y - terrainHeight(x, z);
}
