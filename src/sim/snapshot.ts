import { Quaternion, Vector3 } from "three";
import type { AircraftState, FlareState, MissileState, ProjectileState } from "./types";

/**
 * A simulation frozen at one tick, in a form that survives JSON: everything a
 * second copy needs to carry on exactly where this one is.
 *
 * Rounds are the bulk of it -- a long burst leaves hundreds in the air -- so
 * they travel packed, nine 32-bit floats each, rather than as objects.
 */
export interface SimSnapshot {
  tick: number;
  time: number;
  finished: boolean;
  winnerId?: string;
  finishReason?: string;
  aircraft: unknown[];
  missiles: unknown[];
  flares: unknown[];
  /** Base64 of nine floats per round: id, which aircraft fired it, position, velocity, age. */
  rounds: string;
  rng: number;
  missileRng: number;
  projectileId: number;
  storeId: number;
  bookkeeping: Array<[string, unknown]>;
  scoring: Array<[string, unknown]>;
  /** How many events had happened by this tick. */
  eventCount: number;
}

const ROUND_FIELDS = 9;

/**
 * Nine significant figures: under a millimetre anywhere in the arena, and
 * half the characters of a full double. Whole numbers -- ids, counts, the
 * random streams -- are left exactly as they are.
 */
function trim(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toPrecision(9));
}

/** A deep copy with vectors and quaternions written as tagged arrays, and numbers trimmed for the wire. */
export function toPlain(value: unknown): unknown {
  if (typeof value === "number") return trim(value);
  if (value instanceof Vector3) return { $v: [trim(value.x), trim(value.y), trim(value.z)] };
  if (value instanceof Quaternion) return { $q: [trim(value.x), trim(value.y), trim(value.z), trim(value.w)] };
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = toPlain(entry);
    return out;
  }
  return value;
}

/** The reverse of `toPlain`: fresh objects, sharing nothing with what they came from. */
export function fromPlain<T>(value: unknown): T {
  return revive(value) as T;
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const v = record["$v"];
    if (Array.isArray(v) && v.length === 3) return new Vector3(v[0], v[1], v[2]);
    const q = record["$q"];
    if (Array.isArray(q) && q.length === 4) return new Quaternion(q[0], q[1], q[2], q[3]);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = revive(entry);
    return out;
  }
  return value;
}

export function packRounds(rounds: readonly ProjectileState[], aircraft: readonly AircraftState[]): string {
  const floats = new Float32Array(rounds.length * ROUND_FIELDS);
  rounds.forEach((round, index) => {
    const at = index * ROUND_FIELDS;
    floats[at] = round.id;
    floats[at + 1] = Math.max(0, aircraft.findIndex((candidate) => candidate.id === round.ownerId));
    floats[at + 2] = round.position.x;
    floats[at + 3] = round.position.y;
    floats[at + 4] = round.position.z;
    floats[at + 5] = round.velocity.x;
    floats[at + 6] = round.velocity.y;
    floats[at + 7] = round.velocity.z;
    floats[at + 8] = round.age;
  });
  const bytes = new Uint8Array(floats.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function unpackRounds(packed: string, aircraft: readonly AircraftState[]): ProjectileState[] {
  const binary = atob(packed);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const floats = new Float32Array(bytes.buffer);
  const rounds: ProjectileState[] = [];
  for (let at = 0; at + ROUND_FIELDS <= floats.length; at += ROUND_FIELDS) {
    const position = new Vector3(floats[at + 2], floats[at + 3], floats[at + 4]);
    rounds.push({
      id: floats[at]!,
      ownerId: aircraft[floats[at + 1]!]?.id ?? "",
      position,
      // The next step moves this up before it moves the round, so where it is will do.
      previousPosition: position.clone(),
      velocity: new Vector3(floats[at + 5], floats[at + 6], floats[at + 7]),
      age: floats[at + 8]!,
    });
  }
  return rounds;
}

export function reviveAircraft(plain: unknown[]): AircraftState[] {
  return plain.map((entry) => fromPlain<AircraftState>(entry));
}

export function reviveMissiles(plain: unknown[]): MissileState[] {
  return plain.map((entry) => fromPlain<MissileState>(entry));
}

export function reviveFlares(plain: unknown[]): FlareState[] {
  return plain.map((entry) => fromPlain<FlareState>(entry));
}
