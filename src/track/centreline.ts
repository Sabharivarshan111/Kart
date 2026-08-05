import { CONFIG } from '../core/config.ts';
import { SurfaceKind, WallKind } from '../core/contracts.ts';
import type { CentrelineVertex, Station, StretchSpec, TrackSpec } from '../core/contracts.ts';
import { len2, raisedCosine, wrapLength } from '../core/mathx.ts';

/**
 * Authoring: a **closed polygon of legs with a chosen fillet radius at each
 * vertex**, resampled into evenly spaced stations.
 *
 * Why not hand-placed spline points: a spline gives you neither exact closure,
 * nor an exact radius per corner, nor genuinely straight straights. Legs and
 * fillets give all three by construction — the loop closes because the polygon
 * closes, the corner radius is the number you typed, and a leg is a line.
 *
 * The one wrinkle is that a leg meeting an arc has a *step* in curvature, and
 * the brief is explicit that the AI must never meet one. Fixing that by
 * replacing arcs with clothoids would break exact closure, so instead the exact
 * polyline is smoothed with a closed-loop Laplacian pass **weighted to the
 * junction neighbourhoods**. Smoothing a closed polyline cannot open it, the
 * weights are zero along straights so straights stay straight, and the achieved
 * radius shifts by well under a metre — which the validator then measures for
 * real rather than trusting the authored number.
 */

/** Fine sampling used to build the exact path before smoothing and resampling.
 *  0.2 m keeps the arc-length error under 1 mm on the tightest radius we allow. */
const FINE_SPACING = 0.2;

/** Laplacian smoothing iterations across fillet junctions. 24 measured: below
 *  ~12 a curvature step is still visible as an AI steering twitch on entry;
 *  above ~40 the corner radius has moved enough that the authored number stops
 *  meaning anything. */
const SMOOTH_ITERATIONS = 24;

interface FinePoint {
  x: number;
  z: number;
  /** 0 on a straight far from a junction, 1 at a junction. Drives smoothing. */
  junction: number;
}

export interface Centreline {
  stations: Station[];
  /** Total lap length, metres. */
  length: number;
  /** Uniform station spacing actually used. */
  spacing: number;
  /** Achieved minimum radius of curvature, metres — measured, not authored. */
  minRadius: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Geometry problems found while building. The validator turns these into
 *  failures; building never silently repairs a track. */
export interface BuildIssue {
  kind: string;
  message: string;
}

export function buildCentreline(
  spec: TrackSpec,
  issues: BuildIssue[] = [],
): Centreline {
  const fine = buildExactPath(spec.vertices, issues);
  smoothJunctions(fine);
  const stations = resample(fine, CONFIG.track.stationSpacing);
  applyStations(stations, spec, issues);

  let minRadius = Infinity;
  for (const s of stations) {
    const k = Math.abs(s.curvature);
    if (k > 1e-6) minRadius = Math.min(minRadius, 1 / k);
  }

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const s of stations) {
    bounds.minX = Math.min(bounds.minX, s.x);
    bounds.maxX = Math.max(bounds.maxX, s.x);
    bounds.minZ = Math.min(bounds.minZ, s.z);
    bounds.maxZ = Math.max(bounds.maxZ, s.z);
  }

  const length = stations.length * CONFIG.track.stationSpacing;
  return { stations, length, spacing: CONFIG.track.stationSpacing, minRadius, bounds };
}

/** Legs and circular fillets, sampled finely. Exact by construction. */
function buildExactPath(vertices: CentrelineVertex[], issues: BuildIssue[]): FinePoint[] {
  const n = vertices.length;
  if (n < 3) {
    issues.push({ kind: 'degenerate', message: `centreline needs at least 3 vertices, got ${n}` });
    return [];
  }

  // Per vertex: the tangent distance the fillet eats into each adjoining leg.
  const tangentDist = new Array<number>(n).fill(0);
  const arcAngle = new Array<number>(n).fill(0);
  const turnSign = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const p = vertices[(i - 1 + n) % n]!;
    const c = vertices[i]!;
    const q = vertices[(i + 1) % n]!;

    let inX = c.x - p.x;
    let inZ = c.z - p.z;
    let outX = q.x - c.x;
    let outZ = q.z - c.z;
    const inLen = len2(inX, inZ);
    const outLen = len2(outX, outZ);
    if (inLen < 1e-6 || outLen < 1e-6) {
      issues.push({ kind: 'degenerate', message: `zero-length leg at vertex ${i}` });
      continue;
    }
    inX /= inLen;
    inZ /= inLen;
    outX /= outLen;
    outZ /= outLen;

    // Deflection angle between the two legs (0 = straight through).
    const cross = inX * outZ - inZ * outX;
    const dot = inX * outX + inZ * outZ;
    const deflection = Math.atan2(cross, dot);
    const absDef = Math.abs(deflection);
    if (absDef < 1e-4) continue; // effectively straight; no fillet needed

    arcAngle[i] = absDef;
    turnSign[i] = Math.sign(cross);
    // Tangent distance for a circular fillet of radius r at deflection θ.
    tangentDist[i] = c.radius * Math.tan(absDef / 2);
  }

  // Overlapping fillets are a hard authoring error: two corners eating the same
  // leg produce a path that reverses on itself. Reported, not repaired.
  for (let i = 0; i < n; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % n]!;
    const legLen = len2(b.x - a.x, b.z - a.z);
    const used = tangentDist[i]! + tangentDist[(i + 1) % n]!;
    if (used > legLen - 0.05) {
      issues.push({
        kind: 'overlapping-fillets',
        message:
          `fillets at vertices ${i} and ${(i + 1) % n} need ${used.toFixed(2)} m ` +
          `of a ${legLen.toFixed(2)} m leg — reduce a radius`,
      });
    }
  }

  const out: FinePoint[] = [];
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i - 1 + n) % n]!;
    const c = vertices[i]!;
    const next = vertices[(i + 1) % n]!;

    const inLen = len2(c.x - prev.x, c.z - prev.z);
    const outLen = len2(next.x - c.x, next.z - c.z);
    if (inLen < 1e-6 || outLen < 1e-6) continue;
    const inX = (c.x - prev.x) / inLen;
    const inZ = (c.z - prev.z) / inLen;
    const outX = (next.x - c.x) / outLen;
    const outZ = (next.z - c.z) / outLen;

    const d = tangentDist[i]!;
    const theta = arcAngle[i]!;
    const sign = turnSign[i]!;

    // Straight from the previous fillet's exit to this fillet's entry.
    const legStartX = prev.x + inX * tangentDist[(i - 1 + n) % n]!;
    const legStartZ = prev.z + inZ * tangentDist[(i - 1 + n) % n]!;
    const entryX = c.x - inX * d;
    const entryZ = c.z - inZ * d;
    emitLine(out, legStartX, legStartZ, entryX, entryZ);

    if (theta > 1e-4 && d > 1e-6) {
      // Arc centre sits perpendicular to the incoming direction, on the inside.
      const r = c.radius;
      const nx = -inZ * sign;
      const nz = inX * sign;
      const cxArc = entryX + nx * r;
      const czArc = entryZ + nz * r;
      const startAngle = Math.atan2(entryZ - czArc, entryX - cxArc);
      const steps = Math.max(2, Math.ceil((r * theta) / FINE_SPACING));
      for (let s = 1; s <= steps; s++) {
        const a = startAngle + sign * theta * (s / steps);
        // Junction weight peaks at the arc ends, where the curvature step is.
        const edge = Math.min(s, steps - s) / steps;
        out.push({
          x: cxArc + Math.cos(a) * r,
          z: czArc + Math.sin(a) * r,
          junction: 1 - Math.min(1, edge * 4),
        });
      }
    }
    void outX;
    void outZ;
  }
  return out;
}

function emitLine(out: FinePoint[], ax: number, az: number, bx: number, bz: number): void {
  const dist = len2(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(dist / FINE_SPACING));
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    // Junction weight rises only in the last/first few metres of the leg, so
    // the middle of a straight is never touched and stays exactly straight.
    const metresFromStart = t * dist;
    const metresFromEnd = dist - metresFromStart;
    const near = Math.min(metresFromStart, metresFromEnd);
    out.push({
      x: ax + (bx - ax) * t,
      z: az + (bz - az) * t,
      junction: Math.max(0, 1 - near / CONFIG.track.curvatureRamp),
    });
  }
}

/**
 * Closed-loop Laplacian smoothing, weighted by junction proximity. Cannot open
 * the loop (every point is replaced by a blend of itself and its two
 * neighbours, and the neighbourhood wraps), and is a no-op wherever the weight
 * is zero.
 */
function smoothJunctions(pts: FinePoint[]): void {
  const n = pts.length;
  if (n < 8) return;
  const bufX = new Float64Array(n);
  const bufZ = new Float64Array(n);
  for (let iter = 0; iter < SMOOTH_ITERATIONS; iter++) {
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      const w = b.junction * 0.5;
      bufX[i] = b.x * (1 - w) + (a.x + c.x) * 0.5 * w;
      bufZ[i] = b.z * (1 - w) + (a.z + c.z) * 0.5 * w;
    }
    for (let i = 0; i < n; i++) {
      pts[i]!.x = bufX[i]!;
      pts[i]!.z = bufZ[i]!;
    }
  }
}

/** Uniform resampling of the closed smoothed polyline into stations. */
function resample(pts: FinePoint[], spacing: number): Station[] {
  const n = pts.length;
  if (n < 3) return [];

  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    cum[i + 1] = cum[i]! + len2(b.x - a.x, b.z - a.z);
  }
  const total = cum[n]!;
  // Round the station count so the loop closes on a whole station: a partial
  // final gap makes u discontinuous across the start line, which shows up as a
  // one-frame steering flick every lap.
  const count = Math.max(8, Math.round(total / spacing));
  const step = total / count;

  const stations: Station[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = i * step;
    while (seg < n - 1 && cum[seg + 1]! < target) seg++;
    const segLen = cum[seg + 1]! - cum[seg]!;
    const t = segLen > 1e-9 ? (target - cum[seg]!) / segLen : 0;
    const a = pts[seg]!;
    const b = pts[(seg + 1) % n]!;
    stations.push(blankStation(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, target));
  }

  // Tangents by central difference on the closed loop, then curvature from the
  // turn rate per unit arc length. Derived from the final geometry, so it is
  // what the kart actually drives — not what was authored.
  const m = stations.length;
  for (let i = 0; i < m; i++) {
    const a = stations[(i - 1 + m) % m]!;
    const b = stations[(i + 1) % m]!;
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = len2(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const s = stations[i]!;
    s.tx = dx;
    s.tz = dz;
    s.ty = 0; // filled in with elevation
    // Horizontal right-hand vector: (tz, -tx) with x right, z forward, y up.
    s.rx = dz;
    s.rz = -dx;
  }
  for (let i = 0; i < m; i++) {
    const a = stations[(i - 1 + m) % m]!;
    const b = stations[(i + 1) % m]!;
    const cross = a.tx * b.tz - a.tz * b.tx;
    const dot = a.tx * b.tx + a.tz * b.tz;
    const turn = Math.atan2(cross, dot);
    // Curvature sign convention: +ve turns right, matching the right vector.
    stations[i]!.curvature = -turn / (2 * step);
  }
  return stations;
}

function blankStation(x: number, z: number, u: number): Station {
  return {
    u,
    x,
    y: 0,
    z,
    tx: 0,
    ty: 0,
    tz: 1,
    rx: 1,
    rz: 0,
    halfWidth: CONFIG.track.stationSpacing,
    bank: 0,
    surface: SurfaceKind.Road,
    vergeSurface: SurfaceKind.Grass,
    wall: WallKind.Barrier,
    curvature: 0,
    jump: false,
  };
}

/**
 * Per-station authored data. Width, banking and elevation are blended with a
 * raised cosine across each stretch's boundaries; a step in any of them is a
 * visible notch in the road, and a step in elevation is a wall.
 */
function applyStations(stations: Station[], spec: TrackSpec, issues: BuildIssue[]): void {
  const m = stations.length;
  if (!m) return;
  const total = m * CONFIG.track.stationSpacing;

  const halfWidth = new Float64Array(m).fill(spec.defaults.halfWidth);
  const bank = new Float64Array(m);
  const elevation = new Float64Array(m);

  for (let i = 0; i < m; i++) {
    stations[i]!.surface = spec.defaults.surface;
    stations[i]!.vergeSurface = spec.defaults.vergeSurface;
    stations[i]!.wall = spec.defaults.wall;
    stations[i]!.jump = false;
  }

  for (const st of spec.stretches) {
    applyStretch(stations, halfWidth, bank, elevation, st, total, issues);
  }

  // A short closed-loop smoothing pass on elevation and bank. The cosine ramps
  // already remove value steps; this removes the remaining *derivative* steps
  // where two stretches abut, which are what a suspension reads as a kerb.
  smoothClosed(elevation, 6);
  smoothClosed(bank, 6);
  smoothClosed(halfWidth, 3);

  for (let i = 0; i < m; i++) {
    const s = stations[i]!;
    s.halfWidth = halfWidth[i]!;
    s.bank = bank[i]!;
    s.y = elevation[i]!;
  }

  // Climb rate goes into the tangent's y so the tangent is a true 3D unit
  // vector. The respawn code uses it directly, and a respawn that ignores the
  // climb points the kart into the road on a descent.
  for (let i = 0; i < m; i++) {
    const a = stations[(i - 1 + m) % m]!;
    const b = stations[(i + 1) % m]!;
    const dy = b.y - a.y;
    const horiz = 2 * CONFIG.track.stationSpacing;
    const s = stations[i]!;
    const inv = 1 / Math.sqrt(horiz * horiz + dy * dy);
    const scale = horiz * inv;
    s.tx *= scale;
    s.tz *= scale;
    s.ty = dy * inv;
  }
}

function applyStretch(
  stations: Station[],
  halfWidth: Float64Array,
  bank: Float64Array,
  elevation: Float64Array,
  st: StretchSpec,
  total: number,
  issues: BuildIssue[],
): void {
  const m = stations.length;
  if (st.from < 0 || st.from > 1 || st.to < 0 || st.to > 1) {
    issues.push({ kind: 'bad-stretch', message: `stretch bounds must be 0..1, got ${st.from}..${st.to}` });
    return;
  }
  const spacing = CONFIG.track.stationSpacing;
  const startU = st.from * total;
  const endU = st.to * total;
  let span = endU - startU;
  if (span <= 0) span += total; // wraps across the start line
  if (span < spacing) {
    issues.push({ kind: 'bad-stretch', message: `stretch ${st.from}..${st.to} is shorter than one station` });
    return;
  }

  // Ramp length: a quarter of the stretch by default, capped, so short
  // stretches still get a blend rather than a step and long ones do not spend
  // half their length ramping. Authors override it for elevation, where the
  // ramp length is literally the gradient of the hill.
  const ramp = Math.min(
    st.rampMetres !== undefined ? st.rampMetres : span * 0.25,
    span * 0.5,
  );
  if (st.rampMetres !== undefined && st.rampMetres > span * 0.5) {
    issues.push({
      kind: 'ramp-too-long',
      message: `stretch ${st.from}..${st.to} asks for a ${st.rampMetres} m ramp on a ${span.toFixed(1)} m span; clamped to half the span`,
    });
  }

  const first = Math.round(startU / spacing);
  const count = Math.round(span / spacing);
  for (let k = 0; k <= count; k++) {
    const idx = ((first + k) % m + m) % m;
    const along = k * spacing;
    const fromEnd = span - along;
    const blend = Math.min(
      ramp > 0 ? raisedCosine(along / ramp) : 1,
      ramp > 0 ? raisedCosine(fromEnd / ramp) : 1,
    );
    if (st.halfWidth !== undefined) {
      halfWidth[idx] = halfWidth[idx]! + (st.halfWidth - halfWidth[idx]!) * blend;
    }
    if (st.bankDeg !== undefined) {
      const target = (st.bankDeg * Math.PI) / 180;
      bank[idx] = bank[idx]! + (target - bank[idx]!) * blend;
    }
    if (st.elevation !== undefined) {
      elevation[idx] = elevation[idx]! + (st.elevation - elevation[idx]!) * blend;
    }
    // Categorical data does not blend — half a kerb is not a thing. It applies
    // across the core of the stretch only, so the ramp zones keep their
    // neighbour's surface and the transition lands where the geometry is
    // already moving.
    const inCore = blend > 0.5;
    if (inCore) {
      const s = stations[idx]!;
      if (st.surface !== undefined) s.surface = st.surface;
      if (st.vergeSurface !== undefined) s.vergeSurface = st.vergeSurface;
      if (st.wall !== undefined) s.wall = st.wall;
      if (st.jump !== undefined) s.jump = st.jump;
    }
  }
}

function smoothClosed(arr: Float64Array, iterations: number): void {
  const n = arr.length;
  if (n < 3) return;
  const buf = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      buf[i] = (arr[(i - 1 + n) % n]! + 2 * arr[i]! + arr[(i + 1) % n]!) * 0.25;
    }
    arr.set(buf);
  }
}

/** Station index for an arc length, wrapping. */
export function stationIndexAt(cl: Centreline, u: number): number {
  const m = cl.stations.length;
  return Math.floor(wrapLength(u, cl.length) / cl.spacing) % m;
}
