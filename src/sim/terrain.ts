
export const TERRAIN_EXTENT_M = 80_000;

export const TERRAIN_CHUNKS = 8;
export const TERRAIN_CHUNK_SEGMENTS = 38;
export const TERRAIN_GRID_STEP_M = TERRAIN_EXTENT_M / (TERRAIN_CHUNKS * TERRAIN_CHUNK_SEGMENTS);

export const SEA_LEVEL_M = 0;

function hash(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 374_761_393) + Math.imul(iy | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function fractal(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += noise(x * frequency, y * frequency) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

function ridged(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    const folded = 1 - Math.abs(noise(x * frequency, y * frequency) * 2 - 1);
    sum += folded * folded * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

export function terrainElevation(x: number, z: number): number {
  const continent = fractal(x / 26_000 + 12.3, z / 26_000 - 4.7, 4);
  const centreBias = Math.exp(-(x * x + z * z) / (2 * 14_000 * 14_000)) * 0.13;
  const land = continent + centreBias - 0.53;

  if (land <= 0) return land * 3_200;

  const shore = Math.min(1, land / 0.12);
  const massif = Math.min(1, land / 0.22);
  const range = ridged(x / 7_400 - 31.2, z / 7_400 + 8.9, 5);
  const relief = fractal(x / 2_300 + 5.1, z / 2_300 + 17.4, 4) - 0.5;

  return land * 1_500 * shore + range * range * 1_900 * massif + relief * 210 * shore;
}

/**
 * The elevation the drawn mesh actually has at this point.
 *
 * Not `terrainElevation`, which is the smooth field the mesh's vertices are
 * sampled from: between those vertices the mesh is flat triangles, and the gap
 * between the two reached a hundred and eighty metres -- aircraft colliding
 * with ground that was not where it was drawn. THREE.PlaneGeometry splits each
 * quad along the anti-diagonal, so the halves are chosen at fx + fz = 1 and
 * each is the plane through its three corners.
 */
export function sampledElevation(x: number, z: number): number {
  const half = TERRAIN_EXTENT_M / 2;
  if (x < -half || x >= half || z < -half || z >= half) return terrainElevation(x, z);

  const step = TERRAIN_GRID_STEP_M;
  const gridX = Math.floor((x + half) / step) * step - half;
  const gridZ = Math.floor((z + half) / step) * step - half;
  const fx = (x - gridX) / step;
  const fz = (z - gridZ) / step;

  if (fx + fz <= 1) {
    const origin = terrainElevation(gridX, gridZ);
    return (
      origin +
      (terrainElevation(gridX + step, gridZ) - origin) * fx +
      (terrainElevation(gridX, gridZ + step) - origin) * fz
    );
  }
  const far = terrainElevation(gridX + step, gridZ + step);
  return (
    far +
    (terrainElevation(gridX, gridZ + step) - far) * (1 - fx) +
    (terrainElevation(gridX + step, gridZ) - far) * (1 - fz)
  );
}

export function terrainHeight(x: number, z: number): number {
  return Math.max(sampledElevation(x, z), SEA_LEVEL_M);
}

export function isWater(x: number, z: number): boolean {
  return sampledElevation(x, z) < SEA_LEVEL_M;
}

export function elevationNormal(x: number, z: number, epsilon = 25): [number, number, number] {
  const dx = (terrainElevation(x + epsilon, z) - terrainElevation(x - epsilon, z)) / (2 * epsilon);
  const dz = (terrainElevation(x, z + epsilon) - terrainElevation(x, z - epsilon)) / (2 * epsilon);
  const length = Math.hypot(dx, 1, dz);
  return [-dx / length, 1 / length, -dz / length];
}

export function heightAboveGround(x: number, y: number, z: number): number {
  return y - terrainHeight(x, z);
}
