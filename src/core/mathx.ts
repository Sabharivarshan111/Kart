/**
 * Small scalar helpers. Deliberately scalar and allocation-free: everything in
 * the physics path works on numbers, not on Vector3s, because
 * ARCHITECTURE.md §4 bans allocation in the frame loop and the easiest way to
 * obey that is to have nothing to allocate.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, clamped. Returns 0 when a === b rather than NaN. */
export function invLerp(a: number, b: number, v: number): number {
  if (a === b) return 0;
  return clamp01((v - a) / (b - a));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Raised cosine 0→1 over t∈[0,1]. Used for curvature and elevation ramps: a
 *  linear ramp leaves a discontinuity in the *derivative*, which the AI reads
 *  as a step change in steering demand. */
export function raisedCosine(t: number): number {
  const c = clamp01(t);
  return 0.5 - 0.5 * Math.cos(Math.PI * c);
}

/** Frame-rate independent exponential approach. `rate` is 1/seconds.
 *  Never use `lerp(a, b, 0.1)` per frame — that constant means something
 *  different at 30 fps and at 144 fps. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Shortest signed angular difference from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Wrap an arc-length into [0, length). */
export function wrapLength(u: number, length: number): number {
  let x = u % length;
  if (x < 0) x += length;
  return x;
}

/** Shortest signed arc-length difference on a closed loop. */
export function loopDelta(from: number, to: number, length: number): number {
  let d = wrapLength(to - from, length);
  if (d > length * 0.5) d -= length;
  return d;
}

export function sqr(x: number): number {
  return x * x;
}

/** Length of a 2D vector without allocating. */
export function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** Signed distance from point p to the infinite line through (ax,az) with unit
 *  direction (dx,dz). Positive is to the direction's right in XZ (x right,
 *  z forward, y up ⇒ right = (dz, -dx)). */
export function signedLateral(
  px: number,
  pz: number,
  ax: number,
  az: number,
  dx: number,
  dz: number,
): number {
  return (px - ax) * dz - (pz - az) * dx;
}

/**
 * Closest point on segment AB to P, returned as the parameter t∈[0,1].
 * Degenerate segments return 0 instead of NaN — a zero-length station gap is a
 * validator failure, but the query must not produce NaN before the validator
 * gets a chance to say so.
 */
export function closestOnSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const denom = abx * abx + abz * abz;
  if (denom <= 1e-12) return 0;
  return clamp01(((px - ax) * abx + (pz - az) * abz) / denom);
}

/** Do segments AB and CD properly intersect? Used by the track validator to
 *  catch unintended self-intersection (bug class 11). Shared endpoints do not
 *  count, which is why this is a strict test. */
export function segmentsIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1 = cross(cx, cz, dx, dz, ax, az);
  const d2 = cross(cx, cz, dx, dz, bx, bz);
  const d3 = cross(ax, az, bx, bz, cx, cz);
  const d4 = cross(ax, az, bx, bz, dx, dz);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function cross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

/** Axis-aligned rectangle overlap. The brief is explicit that overlaps are
 *  asserted as rectangle intersections rather than compared by eye. */
export function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}
