/** Value noise, shared by the terrain field and the cloud texture. */
function hash(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 374_761_393) + Math.imul(iy | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

export function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** A `period` wraps the lattice, which is what lets a texture tile. */
export function noise(x: number, y: number, period?: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const at = period === undefined ? hash : (gx: number, gy: number) => hash(((gx % period) + period) % period, ((gy % period) + period) % period);
  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const d = at(ix + 1, iy + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export function fractal(x: number, y: number, octaves: number, basePeriod?: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    const period = basePeriod === undefined ? undefined : basePeriod * frequency;
    sum += noise(x * frequency, y * frequency, period) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}
