/**
 * Deterministic analytic terrain shared by the simulation and the renderer, so
 * that what the physics treats as ground is exactly what the viewer draws.
 *
 * It is layered value noise rather than a heightmap: no asset to ship, no seed
 * to store in a replay, and any point can be sampled directly, which the flight
 * model needs for height above ground on every tick.
 */

export const TERRAIN_EXTENT_M = 80_000;

/**
 * The ground is a heightfield, not a formula.
 *
 * The noise below generates the vertices; the surface is the triangles between
 * them. That distinction is the whole point: the renderer can only draw
 * triangles, so if the simulation collided with the underlying formula instead,
 * the two would disagree wherever the real surface bulges above the flat
 * triangle spanning it -- by up to 183 metres, measured, on a steep ridge. A
 * pilot judges clearance by what is on the screen, and would fly visibly clear
 * of a ridge and hit nothing at all.
 *
 * So these are shared with the renderer, which must build its mesh on exactly
 * this grid, and the sampling below reproduces exactly its triangles.
 */
export const TERRAIN_CHUNKS = 8;
export const TERRAIN_CHUNK_SEGMENTS = 38;
export const TERRAIN_GRID_STEP_M = TERRAIN_EXTENT_M / (TERRAIN_CHUNKS * TERRAIN_CHUNK_SEGMENTS);

/** Elevations below this are sea; the surface is drawn and flown as water. */
export const SEA_LEVEL_M = 0;

/** Integer hash, 32-bit, stable across engines. */
function hash(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 374_761_393) + Math.imul(iy | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1]. */
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

/** Fractal noise: octaves of halving amplitude and doubling frequency. */
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

/**
 * Ridged noise, for mountain crests.
 *
 * Folding the noise about its midpoint turns smooth hills into sharp ridges,
 * which is what makes a range read as a range rather than as lumps.
 */
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

/**
 * Terrain elevation in metres. Negative is sea floor.
 *
 * Built from three layers: a continental mask that decides land from water, a
 * ridged range that only rises where the continent is well above sea level, and
 * fine detail everywhere. The arena centre is biased upward so the fight always
 * starts over land and the hard deck means something.
 */
export function terrainElevation(x: number, z: number): number {
  const continent = fractal(x / 26_000 + 12.3, z / 26_000 - 4.7, 4);
  // Keep the middle of the arena above water.
  const centreBias = Math.exp(-(x * x + z * z) / (2 * 14_000 * 14_000)) * 0.13;
  const land = continent + centreBias - 0.53;

  // Coast falls away quickly; sea floor keeps sloping so the water has depth.
  if (land <= 0) return land * 3_200;

  const shore = Math.min(1, land / 0.12);
  const massif = Math.min(1, land / 0.22);
  const range = ridged(x / 7_400 - 31.2, z / 7_400 + 8.9, 5);
  const relief = fractal(x / 2_300 + 5.1, z / 2_300 + 17.4, 4) - 0.5;

  return land * 1_500 * shore + range * range * 1_900 * massif + relief * 210 * shore;
}

/**
 * Elevation of the drawn surface: the triangle, not the formula.
 *
 * `PlaneGeometry` splits every quad along the anti-diagonal -- the first
 * triangle is the corner nearest the grid origin, the second the corner
 * furthest from it -- so the point is interpolated over whichever of the two it
 * actually falls in. Outside the meshed extent there are no triangles, and
 * nothing can fly that far out anyway, so the formula stands in.
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

/**
 * Surface the aircraft collides with.
 *
 * Water is a floor, not a hole: sea level is as low as anything flies, and
 * hitting it is hitting the ground.
 */
export function terrainHeight(x: number, z: number): number {
  return Math.max(sampledElevation(x, z), SEA_LEVEL_M);
}

export function isWater(x: number, z: number): boolean {
  return sampledElevation(x, z) < SEA_LEVEL_M;
}

/**
 * Upward normal of the elevation field, including the sea floor.
 *
 * Separate from `terrainNormal` because that one follows the collision surface,
 * which is flat wherever there is water. The renderer wants the shape of the
 * ground itself so the shallows and the coastline shade as slopes.
 *
 * Computing normals analytically rather than averaging mesh faces is what lets
 * the ground be split into separately drawn chunks: two chunks that meet at an
 * edge agree exactly on the normal there, so there is no lighting seam.
 */
export function elevationNormal(x: number, z: number, epsilon = 25): [number, number, number] {
  const dx = (terrainElevation(x + epsilon, z) - terrainElevation(x - epsilon, z)) / (2 * epsilon);
  const dz = (terrainElevation(x, z + epsilon) - terrainElevation(x, z - epsilon)) / (2 * epsilon);
  const length = Math.hypot(dx, 1, dz);
  return [-dx / length, 1 / length, -dz / length];
}

/** Upward surface normal, used for impact geometry and for lighting the mesh. */
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
