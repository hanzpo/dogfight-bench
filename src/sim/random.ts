export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }

  /** Where the stream has got to, so it can be carried to another machine and picked up there. */
  save(): number {
    return this.state;
  }

  load(state: number): void {
    this.state = state >>> 0 || 1;
  }

  normal(): number {
    const u = Math.max(this.next(), Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
}

/**
 * Spreads a seed across all 32 bits.
 *
 * Xorshift's first few draws barely move between neighbouring seeds, so
 * seeds 1, 2 and 3 used to roll the same first number -- which a flare that
 * gets one chance to decoy a missile turns into the same outcome every match.
 */
export function mixSeed(seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85eb_ca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
