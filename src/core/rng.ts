/**
 * Seeded deterministic RNG. `Math.random` is banned in `src/` — a named
 * screenshot has to produce the same frame every run, and the item balance
 * table is only meaningful if a hundred races can be reproduced.
 *
 * mulberry32: 32-bit state, passes the small-crush smoke tests that matter for
 * gameplay noise, and is three lines. Not for cryptography, and nothing here
 * is.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to a non-zero uint32; seed 0 is a legitimate URL value and would
    // otherwise emit a constant stream.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  /** Index into a weight array, proportional to the weights. Returns -1 only if
   *  every weight is zero, which callers must handle rather than assume. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]!);
    if (total <= 0) return -1;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]!);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Fork a child stream. Used so one subsystem consuming a different number of
   *  values does not shift every other subsystem's sequence — without this,
   *  adding one AI mistake roll changes every item draw in the race. */
  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0);
  }

  snapshot(): number {
    return this.state;
  }

  restore(state: number): void {
    this.state = state >>> 0;
  }
}

/** The seed for this session, from `?seed=`. A named shot always produces the
 *  same frame because of this. */
export function seedFromLocation(defaultSeed = 1): number {
  if (typeof location === 'undefined') return defaultSeed;
  const raw = new URLSearchParams(location.search).get('seed');
  if (raw === null) return defaultSeed;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultSeed;
}
