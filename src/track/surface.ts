import { CONFIG } from '../core/config.ts';
import { SurfaceKind, WallKind } from '../core/contracts.ts';
import type { Station, SurfaceSample } from '../core/contracts.ts';
import { closestOnSegment, len2, wrapLength } from '../core/mathx.ts';
import type { Centreline } from './centreline.ts';

/**
 * ================== THE ONE TRACK SURFACE ==================
 *
 * `surfaceAt(x, z)` is the single answer to "what is under this point", and the
 * physics, the mesh builder, the AI, the camera, the item placement and the
 * respawn logic all ask it. Nothing anywhere else derives ground height by any
 * other means — not by raycasting the render mesh, not from a cached
 * heightmap, not by assuming a stretch is flat.
 *
 * If the render mesh and this query ever disagree, karts sink into visibly
 * solid road or float above it, and finding out why costs a day. They cannot
 * disagree here because `track/mesh.ts` is generated from the same station
 * array this reads, using the same cross-section function below.
 *
 * SELF-CROSSING DECISION (ARCHITECTURE.md §3.1): crossings are **forbidden**
 * and the validator fails any track that has one. `hintU` is therefore a pure
 * performance hint — it narrows the station search and never changes the
 * answer. A bridge would require reopening that decision deliberately.
 */

/** Spatial grid cell size. Must be at least the widest corridor half-extent
 *  (half-width + verge + wall ≈ 13 m on our widest track) so that a 3×3 cell
 *  search around the query point cannot miss the owning station. Shrink it
 *  below that and off-road queries near a wall start returning Void. */
const CELL_SIZE = 16;

/** Station window searched either side of a hint. 40 stations = 40 m; a kart
 *  moves 0.2 m per physics step, so a hint from last step is never stale by
 *  more than a rounding error. Large enough to also absorb a teleport of a few
 *  metres without a wrong answer. */
const HINT_WINDOW = 40;

/** Kerb chamfer: the kerb rises across its full width rather than stepping.
 *  A vertical step is not a kerb, it is a kart-launcher, and the swept wall
 *  test cannot help with a vertical face in the *driving* surface. */
const KERB_RISE_FRACTION = 1.0;

/** How far the verge drops below the road edge, and over what distance. The
 *  drop is what makes running wide *felt* before the grip change arrives. */
const VERGE_DROP = 0.12;
const VERGE_DROP_DISTANCE = 0.9;

export class TrackSurface {
  readonly cl: Centreline;
  private readonly grid = new Map<number, number[]>();
  private readonly gridOriginX: number;
  private readonly gridOriginZ: number;
  private readonly gridCols: number;

  constructor(cl: Centreline) {
    this.cl = cl;
    const pad = CELL_SIZE * 2;
    this.gridOriginX = cl.bounds.minX - pad;
    this.gridOriginZ = cl.bounds.minZ - pad;
    this.gridCols = Math.ceil((cl.bounds.maxX - cl.bounds.minX + pad * 2) / CELL_SIZE) + 1;
    for (let i = 0; i < cl.stations.length; i++) {
      const s = cl.stations[i]!;
      const key = this.cellKey(s.x, s.z);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private cellKey(x: number, z: number): number {
    const cx = Math.floor((x - this.gridOriginX) / CELL_SIZE);
    const cz = Math.floor((z - this.gridOriginZ) / CELL_SIZE);
    return cz * this.gridCols + cx;
  }

  /**
   * THE query. Writes into `out` and returns it — no allocation, because this
   * runs 4 times per kart per physics step (3840 calls a second at 8 karts and
   * 120 Hz) and ARCHITECTURE.md §4 bans allocation in the frame loop.
   */
  sample(x: number, z: number, out: SurfaceSample, hintU?: number): SurfaceSample {
    const stations = this.cl.stations;
    const m = stations.length;
    const best = this.nearestStation(x, z, hintU);

    // Refine against the two segments touching the nearest station, so u is
    // continuous rather than quantised to the station spacing.
    const iPrev = (best - 1 + m) % m;
    const iNext = (best + 1) % m;
    const a = stations[iPrev]!;
    const b = stations[best]!;
    const c = stations[iNext]!;

    const t1 = closestOnSegment(x, z, a.x, a.z, b.x, b.z);
    const d1 = distSq(x, z, a.x + (b.x - a.x) * t1, a.z + (b.z - a.z) * t1);
    const t2 = closestOnSegment(x, z, b.x, b.z, c.x, c.z);
    const d2 = distSq(x, z, b.x + (c.x - b.x) * t2, b.z + (c.z - b.z) * t2);

    let s0: Station;
    let s1: Station;
    let t: number;
    if (d1 <= d2) {
      s0 = a;
      s1 = b;
      t = t1;
    } else {
      s0 = b;
      s1 = c;
      t = t2;
    }

    // Interpolated station frame.
    const px = s0.x + (s1.x - s0.x) * t;
    const pz = s0.z + (s1.z - s0.z) * t;
    const cy = s0.y + (s1.y - s0.y) * t;
    let tx = s0.tx + (s1.tx - s0.tx) * t;
    let ty = s0.ty + (s1.ty - s0.ty) * t;
    let tz = s0.tz + (s1.tz - s0.tz) * t;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    let rx = s0.rx + (s1.rx - s0.rx) * t;
    let rz = s0.rz + (s1.rz - s0.rz) * t;
    const rl = len2(rx, rz) || 1;
    rx /= rl;
    rz /= rl;

    const halfWidth = s0.halfWidth + (s1.halfWidth - s0.halfWidth) * t;
    const bank = s0.bank + (s1.bank - s0.bank) * t;
    // Categorical fields take the nearer station's value — interpolating an
    // enum is meaningless and produces a surface that is 40% grass.
    const near = t < 0.5 ? s0 : s1;

    // u is continuous across the start line because the station count divides
    // the loop exactly (see centreline.resample).
    let u = s0.u + (s1.u - s0.u >= 0 ? s1.u - s0.u : this.cl.length + s1.u - s0.u) * t;
    u = wrapLength(u, this.cl.length);

    // Signed offset along the station's right vector — a **dot** product with
    // r, matching `pointAt` and `mesh.ts`, both of which place a point at
    // `centre + r · lateral`.
    //
    // BUG (fixed): this was written as the 2D cross product `dx·rz − dz·rx`,
    // which is the component along the *tangent*, not along r. Because (px,pz)
    // is the closest point on the centreline the displacement is already
    // perpendicular to the segment, so that expression evaluated to ~0 for
    // every point on the map. SYMPTOM: `lateral` was always ≈0, so `onRoad` was
    // always true, `distanceToEdge` was always the full half-width and
    // `crossSection` always returned Road — walls never fired, the off-road
    // recovery timer never accrued, and a kart teleported 30 m into the scenery
    // drove on invisible tarmac at full road grip.
    const lateral = (x - px) * rx + (z - pz) * rz;

    const profile = crossSection(Math.abs(lateral), halfWidth, near);

    out.u = u;
    out.lateral = lateral;
    out.tx = tx;
    out.ty = ty;
    out.tz = tz;
    out.surface = profile.surface;
    out.onRoad = Math.abs(lateral) <= halfWidth;
    out.distanceToEdge = halfWidth - Math.abs(lateral);
    // Banking: the surface rolls about the tangent, so a point `lateral` metres
    // to the right sits `lateral · tan(bank)` higher. The mesh places its
    // vertices with the identical relation — that is why they cannot disagree.
    out.height = cy + lateral * Math.tan(bank) + profile.rise;

    // Normal from the two surface directions. Computed rather than authored so
    // that banking, climb and the kerb chamfer all show up in it for free.
    const slopeAcross = Math.tan(bank) + profile.slope * Math.sign(lateral || 1);
    // Right vector along the banked surface.
    const brx = rx;
    const bry = slopeAcross;
    const brz = rz;
    // n = right × tangent, flipped to point up.
    let nx = bry * tz - brz * ty;
    let ny = brz * tx - brx * tz;
    let nz = brx * ty - bry * tx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    out.nx = nx;
    out.ny = ny;
    out.nz = nz;
    return out;
  }

  private nearestStation(x: number, z: number, hintU?: number): number {
    const stations = this.cl.stations;
    const m = stations.length;

    if (hintU !== undefined) {
      const centre = Math.floor(wrapLength(hintU, this.cl.length) / this.cl.spacing) % m;
      let best = centre;
      let bestD = Infinity;
      for (let k = -HINT_WINDOW; k <= HINT_WINDOW; k++) {
        const i = ((centre + k) % m + m) % m;
        const s = stations[i]!;
        const d = distSq(x, z, s.x, s.z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor((x - this.gridOriginX) / CELL_SIZE);
    const cz = Math.floor((z - this.gridOriginZ) / CELL_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.grid.get((cz + dz) * this.gridCols + (cx + dx));
        if (!bucket) continue;
        for (const i of bucket) {
          const s = stations[i]!;
          const d = distSq(x, z, s.x, s.z);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0) return best;

    // Far outside the corridor (scenery, a launched kart, a stray projectile).
    // Linear scan rather than a wrong answer; rare enough not to matter.
    for (let i = 0; i < m; i++) {
      const s = stations[i]!;
      const d = distSq(x, z, s.x, s.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Interpolated station data at an arc length. Used by the mesh builder, the
   *  AI racing line, the grid layout and item box placement. */
  stationAt(u: number): Station {
    const m = this.cl.stations.length;
    const uu = wrapLength(u, this.cl.length);
    const f = uu / this.cl.spacing;
    const i0 = Math.floor(f) % m;
    const i1 = (i0 + 1) % m;
    const t = f - Math.floor(f);
    return lerpStation(this.cl.stations[i0]!, this.cl.stations[i1]!, t, uu);
  }

  /** World position at (arc length, horizontal lateral offset), on the driving
   *  surface. The single entry point for "put this thing on the track". */
  pointAt(u: number, lateral: number, out: { x: number; y: number; z: number }): void {
    const s = this.stationAt(u);
    out.x = s.x + s.rx * lateral;
    out.z = s.z + s.rz * lateral;
    out.y = s.y + lateral * Math.tan(s.bank) + crossSection(Math.abs(lateral), s.halfWidth, s).rise;
  }

  /** Distance from the centreline to the inside face of the wall, if any. */
  wallOffsetAt(u: number): number | null {
    const s = this.stationAt(u);
    if (s.wall === WallKind.Open) return null;
    return s.halfWidth + CONFIG.track.vergeWidth;
  }

  get length(): number {
    return this.cl.length;
  }
}

export function blankSample(): SurfaceSample {
  return {
    height: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    surface: SurfaceKind.Void,
    onRoad: false,
    distanceToEdge: -Infinity,
    u: 0,
    lateral: 0,
    tx: 0,
    ty: 0,
    tz: 1,
  };
}

/**
 * The cross-section profile, shared by the query and the mesh builder. Given a
 * horizontal distance from the centreline it returns which material is there,
 * how much the surface rises relative to the banked plane, and the local
 * across-track slope (for the normal).
 *
 * This function existing exactly once is the reason the mesh and the physics
 * cannot disagree.
 */
export function crossSection(
  absLateral: number,
  halfWidth: number,
  station: Station,
): { surface: SurfaceKind; rise: number; slope: number } {
  const kerbW = CONFIG.track.kerbWidth;
  const hasKerb = station.surface === SurfaceKind.Road || station.surface === SurfaceKind.Boost;
  const kerbInner = halfWidth - (hasKerb ? kerbW : 0);

  if (absLateral <= kerbInner) {
    return { surface: station.surface, rise: 0, slope: 0 };
  }

  if (hasKerb && absLateral <= halfWidth) {
    const f = (absLateral - kerbInner) / (kerbW * KERB_RISE_FRACTION);
    const rise = Math.min(1, f) * CONFIG.track.kerbHeight;
    return {
      surface: SurfaceKind.Kerb,
      rise,
      slope: f < 1 ? CONFIG.track.kerbHeight / kerbW : 0,
    };
  }

  const vergeOuter = halfWidth + CONFIG.track.vergeWidth;
  if (absLateral <= vergeOuter) {
    const past = absLateral - halfWidth;
    const kerbTop = hasKerb ? CONFIG.track.kerbHeight : 0;
    const drop = Math.min(1, past / VERGE_DROP_DISTANCE) * VERGE_DROP;
    return {
      surface: station.vergeSurface,
      rise: kerbTop - kerbTop * Math.min(1, past / 0.25) - drop,
      slope: past < VERGE_DROP_DISTANCE ? -VERGE_DROP / VERGE_DROP_DISTANCE : 0,
    };
  }

  // Past the wall line. The wall itself is handled by collision, not by the
  // driving surface: the surface here is Void so that anything that gets past a
  // wall is recovered rather than driven on.
  return { surface: SurfaceKind.Void, rise: -VERGE_DROP, slope: 0 };
}

function lerpStation(a: Station, b: Station, t: number, u: number): Station {
  const near = t < 0.5 ? a : b;
  let tx = a.tx + (b.tx - a.tx) * t;
  let ty = a.ty + (b.ty - a.ty) * t;
  let tz = a.tz + (b.tz - a.tz) * t;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  let rx = a.rx + (b.rx - a.rx) * t;
  let rz = a.rz + (b.rz - a.rz) * t;
  const rl = len2(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  return {
    u,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    tx,
    ty,
    tz,
    rx,
    rz,
    halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t,
    bank: a.bank + (b.bank - a.bank) * t,
    surface: near.surface,
    vergeSurface: near.vergeSurface,
    wall: near.wall,
    curvature: a.curvature + (b.curvature - a.curvature) * t,
    jump: near.jump,
  };
}

function distSq(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
