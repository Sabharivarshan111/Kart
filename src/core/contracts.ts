/**
 * Types that cross module boundaries. This file imports nothing but types and
 * contains no logic — it is the seam described in ARCHITECTURE.md §2.
 */

/**
 * Surface materials a wheel can be standing on. Order is stable; the mesh
 * builder and the audio module both key off it.
 *
 * Written as a frozen object rather than a TS `enum` deliberately: enums are
 * not erasable syntax, so they cannot be run by Node's type stripping and they
 * are banned by `isolatedModules`. The offline track validator runs these same
 * modules under plain Node, and that only works if every construct here is
 * types-plus-values, never a construct the compiler has to synthesise.
 */
export const SurfaceKind = {
  Road: 0,
  Kerb: 1,
  Grass: 2,
  Sand: 3,
  Boost: 4,
  /** Outside the corridor entirely — triggers respawn after a grace period. */
  Void: 5,
} as const;
export type SurfaceKind = (typeof SurfaceKind)[keyof typeof SurfaceKind];

/** What the wall profile does at a given station. */
export const WallKind = {
  /** Solid barrier at the edge of the verge. */
  Barrier: 0,
  /** No wall: drive off and you are in the scenery (and then respawned). */
  Open: 1,
  /** Barrier plus a roof — a tunnel section. */
  Tunnel: 2,
} as const;
export type WallKind = (typeof WallKind)[keyof typeof WallKind];

/**
 * The answer to "what is under this point". Returned by the one track surface
 * query. Mutated in place into a caller-owned instance so the physics loop
 * allocates nothing (ARCHITECTURE.md §4).
 */
export interface SurfaceSample {
  /** World Y of the driving surface at (x, z). */
  height: number;
  /** Unit up-normal of the surface, accounting for banking and elevation. */
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceKind;
  /** True when within the drivable road half-width (not verge, not scenery). */
  onRoad: boolean;
  /** Metres from the point to the nearest road edge. Negative when off-road. */
  distanceToEdge: number;
  /** Arc-length position along the centreline, metres from the start line. */
  u: number;
  /** Signed lateral offset from the centreline. +ve is to the track's right. */
  lateral: number;
  /** Unit tangent of the centreline at u, in world XZ (y is the climb rate). */
  tx: number;
  ty: number;
  tz: number;
}

/**
 * The one control struct (ARCHITECTURE.md §3.4). Player input and AI output are
 * the same shape, and the vehicle only ever moves through this.
 */
export interface Controls {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. +1 (right) */
  steer: number;
  drift: boolean;
  useItem: boolean;
  lookBack: boolean;
}

/** Per-station authored data along the centreline. */
export interface Station {
  /** Arc length from the start line, metres. */
  u: number;
  /** Centreline position. */
  x: number;
  y: number;
  z: number;
  /** Unit tangent (XZ normalised, y = climb). */
  tx: number;
  ty: number;
  tz: number;
  /** Unit lateral (right-hand) vector, horizontal. */
  rx: number;
  rz: number;
  /** Drivable half-width, metres. */
  halfWidth: number;
  /** Banking, radians. Positive rolls the right edge up. */
  bank: number;
  surface: SurfaceKind;
  /** Surface of the verge outside the road, before the wall. */
  vergeSurface: SurfaceKind;
  wall: WallKind;
  /** Signed curvature 1/m at this station; +ve turns right. */
  curvature: number;
  /** True when this stretch is a take-off ramp. */
  jump: boolean;
}

/** A closed centreline authored as legs between vertices with a fillet radius. */
export interface CentrelineVertex {
  x: number;
  z: number;
  /** Corner radius, metres. Must fit between the neighbouring legs. */
  radius: number;
}

/** Per-stretch overrides applied by arc-length fraction of the lap. */
export interface StretchSpec {
  /** Start and end as fractions of total lap length, 0..1. from may exceed to
   *  to wrap across the start line. */
  from: number;
  to: number;
  /**
   * Length in metres of the raised-cosine blend at each end. Defaults to a
   * quarter of the span, capped at 12 m.
   *
   * Worth setting explicitly for elevation, because the blend length *is* the
   * ramp gradient: a 4 m climb over the default 12 m blend peaks at 30°, which
   * launches a kart 100 m. Over 22 m it peaks at 16°, which is a jump.
   */
  rampMetres?: number;
  halfWidth?: number;
  /** Degrees, converted on load — authoring in radians is unreadable. */
  bankDeg?: number;
  /** Height in metres, blended with a raised cosine across the stretch. */
  elevation?: number;
  surface?: SurfaceKind;
  vergeSurface?: SurfaceKind;
  wall?: WallKind;
  jump?: boolean;
}

export interface TrackTheme {
  /** Key into the palette module's theme table. */
  name: string;
  /** Sun elevation and azimuth in radians. Cel bands are tested per theme at
   *  its own sun angle — see bug class 8. */
  sunElevation: number;
  sunAzimuth: number;
}

export interface ItemBoxSpec {
  /** Fraction of lap length. */
  at: number;
  /** Lateral offsets in metres from the centreline. */
  lanes: number[];
}

export interface TrackSpec {
  id: string;
  name: string;
  /** One sentence: the single idea this track is built around. */
  idea: string;
  vertices: CentrelineVertex[];
  defaults: {
    halfWidth: number;
    surface: SurfaceKind;
    vergeSurface: SurfaceKind;
    wall: WallKind;
  };
  stretches: StretchSpec[];
  theme: TrackTheme;
  laps: number;
  itemBoxes: ItemBoxSpec[];
  /** Number of checkpoints; laps require all of them in order. */
  checkpoints: number;
  /** Direction the grid faces: +1 means increasing u. Always +1 for now. */
  direction: 1;
}

/**
 * A cup: four tracks raced in order, points carried between them. Content only
 * — the scoring table lives in `core/config.ts` (`race.cupPoints`) and the
 * standings live in `race/rules.ts`. This is the running order and nothing else.
 */
export interface CupSpec {
  id: string;
  name: string;
  /** One line of UI copy. Shown under the cup name on the select screen. */
  blurb: string;
  /** Track ids, in racing order. Resolved through `trackById`. */
  trackIds: string[];
}

export interface DriverSpec {
  id: string;
  name: string;
  /** One line of character for the select screen. Optional so nothing breaks
   *  if a driver has none. */
  blurb?: string;
  /** What they are studying or rotating through. The medical-student angle is
   *  playful and lives here and in `blurb` — never in anything clinical. */
  rotation?: string;
  /** 0..1 stat weights. They trade off; the sum is deliberately not constant,
   *  because "balanced" is one of the choices. */
  topSpeed: number;
  acceleration: number;
  handling: number;
  /** Mass multiplier. Decides who wins a collision (see collision.ts). */
  weight: number;
  /** Primary body colour key in the palette. */
  colourKey: string;
  /** AI personality when this driver is a rival. */
  ai: {
    /** 0..1 — how close to the ideal speed profile they drive. */
    skill: number;
    /** 0..1 — willingness to take a gap and lean on a rival. */
    aggression: number;
    /** Mistakes per minute at skill 0. Scaled down by skill. */
    sloppiness: number;
  };
}

export type Phase =
  | 'boot'
  | 'menu'
  | 'countdown'
  | 'racing'
  | 'finished'
  | 'paused';

/** Read-only view of a kart for rules, AI, HUD and the harness. */
export interface KartView {
  index: number;
  isPlayer: boolean;
  driverId: string;
  x: number;
  y: number;
  z: number;
  /** Heading in radians, 0 = +Z. */
  heading: number;
  speed: number;
  /** Signed lateral slip velocity, m/s. */
  slip: number;
  drifting: boolean;
  /** 0 = none, 1..3 = charged tier. */
  driftTier: number;
  boostTime: number;
  airborne: boolean;
  surface: SurfaceKind;
  lap: number;
  /** Total progress in metres since the race start — monotonic, and what
   *  positions are sorted by. */
  progress: number;
  position: number;
  spunOut: boolean;
  finished: boolean;
  finishTime: number;
  item: string | null;
}
