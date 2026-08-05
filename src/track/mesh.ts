import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { SurfaceKind, WallKind } from '../core/contracts.ts';
import type { Station } from '../core/contracts.ts';
import type { Theme } from '../core/palette.ts';
import type { Centreline } from './centreline.ts';
import { crossSection } from './surface.ts';

/**
 * The swept track mesh.
 *
 * Built by sweeping the cross-section along the same station array that
 * `surface.ts` queries, using the same `crossSection()` function. That is the
 * whole point: the geometry you see and the geometry you drive on are the same
 * numbers, so a kart cannot sink into visibly solid road.
 *
 * Bands are emitted with *duplicated* vertices at every material boundary. A
 * shared vertex would interpolate its colour across the boundary, and a cel
 * look with a soft gradient at the kerb is not a cel look.
 */

export interface TrackMeshes {
  /** Road, kerbs and verges, one geometry with vertex colours. */
  surface: THREE.BufferGeometry;
  /** Barriers and tunnel roofs. */
  walls: THREE.BufferGeometry;
  /** The start/finish line, drawn as its own strip so it reads at a glance. */
  startLine: THREE.BufferGeometry;
  triangleCount: number;
}

interface Builder {
  pos: number[];
  norm: number[];
  col: number[];
  idx: number[];
}

function builder(): Builder {
  return { pos: [], norm: [], col: [], idx: [] };
}

function finish(b: Builder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

const tmpColour = new THREE.Color();

function pushVertex(
  b: Builder,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  hex: number,
): number {
  const i = b.pos.length / 3;
  b.pos.push(x, y, z);
  b.norm.push(nx, ny, nz);
  // Three.js r152+ renders in linear working space; a hex authored for sRGB has
  // to be converted or every surface reads about 40% too bright and the cel
  // bands land in the wrong places.
  tmpColour.setHex(hex, THREE.SRGBColorSpace);
  b.col.push(tmpColour.r, tmpColour.g, tmpColour.b);
  return i;
}

function pushQuad(b: Builder, a: number, c: number, d: number, e: number): void {
  b.idx.push(a, c, d, a, d, e);
}

/** Horizontal offset → world point on the driving surface at a station. */
function surfacePoint(
  s: Station,
  lateral: number,
  out: { x: number; y: number; z: number },
): void {
  const p = crossSection(Math.abs(lateral), s.halfWidth, s);
  out.x = s.x + s.rx * lateral;
  out.z = s.z + s.rz * lateral;
  out.y = s.y + lateral * Math.tan(s.bank) + p.rise;
}

const pA = { x: 0, y: 0, z: 0 };
const pB = { x: 0, y: 0, z: 0 };
const pC = { x: 0, y: 0, z: 0 };
const pD = { x: 0, y: 0, z: 0 };

/** Face normal of the quad ABCD, written into `out`. Computed from the emitted
 *  vertices rather than from the station frame, so the kerb chamfer and the
 *  verge drop get real normals and pick up real cel bands. */
function quadNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: { x: number; y: number; z: number },
): void {
  const u1x = bx - ax, u1y = by - ay, u1z = bz - az;
  const u2x = cx - ax, u2y = cy - ay, u2z = cz - az;
  let nx = u1y * u2z - u1z * u2y;
  let ny = u1z * u2x - u1x * u2z;
  let nz = u1x * u2y - u1y * u2x;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= l; ny /= l; nz /= l;
  out.x = nx; out.y = ny; out.z = nz;
}

const nrm = { x: 0, y: 1, z: 0 };

function surfaceColour(kind: SurfaceKind, theme: Theme, u: number): number {
  switch (kind) {
    case SurfaceKind.Road:
      return theme.road;
    case SurfaceKind.Boost:
      return theme.boostStrip;
    case SurfaceKind.Grass:
      return theme.grass;
    case SurfaceKind.Sand:
      return theme.sand;
    case SurfaceKind.Kerb:
      // Alternating blocks every 2 m. Read at speed this is what tells you
      // where the edge is without looking at it directly.
      return Math.floor(u / 2) % 2 === 0 ? theme.kerbA : theme.kerbB;
    default:
      return theme.scenery;
  }
}

/**
 * @param density 1 = a ring per station. Quality tiers raise it to 2 or 3,
 *   which is a *structural* decision taken once at load (ARCHITECTURE.md §8) —
 *   the adaptive controller never touches it.
 */
export function buildTrackMeshes(cl: Centreline, theme: Theme, density = 1): TrackMeshes {
  const surf = builder();
  const walls = builder();
  const line = builder();

  const stations = cl.stations;
  const m = stations.length;
  const step = Math.max(1, Math.round(density));

  // Ring indices, so the loop closes back onto its first ring rather than
  // leaving a seam at the start line.
  const ringCount = Math.floor(m / step);

  for (let r = 0; r < ringCount; r++) {
    const i0 = (r * step) % m;
    const i1 = ((r + 1) * step) % m;
    const s0 = stations[i0]!;
    const s1 = stations[i1]!;
    emitBands(surf, s0, s1, theme);
    emitWalls(walls, s0, s1, theme);
  }

  // Start line: a 1.2 m band across the road at u = 0, in its own geometry.
  emitStartLine(line, stations, theme);

  return {
    surface: finish(surf),
    walls: finish(walls),
    startLine: finish(line),
    triangleCount: (surf.idx.length + walls.idx.length + line.idx.length) / 3,
  };
}

/** One ring-to-ring slice of road, kerbs and verges. */
function emitBands(b: Builder, s0: Station, s1: Station, theme: Theme): void {
  const verge = CONFIG.track.vergeWidth;
  const hasKerb0 = s0.surface === SurfaceKind.Road || s0.surface === SurfaceKind.Boost;
  const kerbW = CONFIG.track.kerbWidth;
  const inner0 = s0.halfWidth - (hasKerb0 ? kerbW : 0);
  const inner1 = s1.halfWidth - (hasKerb0 ? kerbW : 0);

  // Road: subdivided into two so a wide banked road still gets two lighting
  // samples across, which matters once the cel ramp quantises.
  band(b, s0, s1, -inner0, -inner1, 0, 0, surfaceColour(s0.surface, theme, s0.u));
  band(b, s0, s1, 0, 0, inner0, inner1, surfaceColour(s0.surface, theme, s0.u));

  if (hasKerb0) {
    const kc = surfaceColour(SurfaceKind.Kerb, theme, s0.u);
    band(b, s0, s1, -s0.halfWidth, -s1.halfWidth, -inner0, -inner1, kc);
    band(b, s0, s1, inner0, inner1, s0.halfWidth, s1.halfWidth, kc);
  }

  const vc = surfaceColour(s0.vergeSurface, theme, s0.u);
  band(b, s0, s1, -(s0.halfWidth + verge), -(s1.halfWidth + verge), -s0.halfWidth, -s1.halfWidth, vc);
  band(b, s0, s1, s0.halfWidth, s1.halfWidth, s0.halfWidth + verge, s1.halfWidth + verge, vc);
}

/** A quad strip between two lateral offsets on two consecutive stations. */
function band(
  b: Builder,
  s0: Station,
  s1: Station,
  l0a: number,
  l1a: number,
  l0b: number,
  l1b: number,
  hex: number,
): void {
  surfacePoint(s0, l0a, pA);
  surfacePoint(s1, l1a, pB);
  surfacePoint(s1, l1b, pC);
  surfacePoint(s0, l0b, pD);
  quadNormal(pA.x, pA.y, pA.z, pB.x, pB.y, pB.z, pC.x, pC.y, pC.z, nrm);
  if (nrm.y < 0) { nrm.x = -nrm.x; nrm.y = -nrm.y; nrm.z = -nrm.z; }
  const a = pushVertex(b, pA.x, pA.y, pA.z, nrm.x, nrm.y, nrm.z, hex);
  const c = pushVertex(b, pB.x, pB.y, pB.z, nrm.x, nrm.y, nrm.z, hex);
  const d = pushVertex(b, pC.x, pC.y, pC.z, nrm.x, nrm.y, nrm.z, hex);
  const e = pushVertex(b, pD.x, pD.y, pD.z, nrm.x, nrm.y, nrm.z, hex);
  pushQuad(b, a, c, d, e);
}

function emitWalls(b: Builder, s0: Station, s1: Station, theme: Theme): void {
  if (s0.wall === WallKind.Open) return;
  const verge = CONFIG.track.vergeWidth;
  const h = CONFIG.track.wallHeight;
  const off0 = s0.halfWidth + verge;
  const off1 = s1.halfWidth + verge;

  for (const side of [-1, 1] as const) {
    surfacePoint(s0, off0 * side, pA);
    surfacePoint(s1, off1 * side, pB);
    // Inner face, lower two-thirds in the wall colour and the top third in the
    // accent, which is what makes a barrier readable at 25 m/s.
    const split = h * 0.62;
    verticalQuad(b, pA, pB, 0, split, theme.wall, side);
    verticalQuad(b, pA, pB, split, h, theme.wallAccent, side);
    // Top cap, so the wall does not read as a zero-thickness sheet from the
    // chase camera on a crest.
    capQuad(b, s0, s1, off0 * side, off1 * side, h, theme.wallAccent);
  }

  if (s0.wall === WallKind.Tunnel) {
    roofQuad(b, s0, s1, off0, off1, CONFIG.track.tunnelHeight, theme.wall);
  }
}

function verticalQuad(
  b: Builder,
  a: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  y0: number,
  y1: number,
  hex: number,
  side: number,
): void {
  // Inward-facing normal: toward the centre of the track.
  let nx = c.z - a.z;
  let nz = -(c.x - a.x);
  const l = Math.hypot(nx, nz) || 1;
  nx = (nx / l) * -side;
  nz = (nz / l) * -side;
  const v0 = pushVertex(b, a.x, a.y + y0, a.z, nx, 0, nz, hex);
  const v1 = pushVertex(b, c.x, c.y + y0, c.z, nx, 0, nz, hex);
  const v2 = pushVertex(b, c.x, c.y + y1, c.z, nx, 0, nz, hex);
  const v3 = pushVertex(b, a.x, a.y + y1, a.z, nx, 0, nz, hex);
  if (side > 0) pushQuad(b, v0, v1, v2, v3);
  else pushQuad(b, v3, v2, v1, v0);
}

function capQuad(
  b: Builder,
  s0: Station,
  s1: Station,
  off0: number,
  off1: number,
  h: number,
  hex: number,
): void {
  const t = CONFIG.track.wallThickness;
  const outer0 = off0 + Math.sign(off0) * t;
  const outer1 = off1 + Math.sign(off1) * t;
  surfacePoint(s0, off0, pA);
  surfacePoint(s1, off1, pB);
  surfacePoint(s1, outer1, pC);
  surfacePoint(s0, outer0, pD);
  const v0 = pushVertex(b, pA.x, pA.y + h, pA.z, 0, 1, 0, hex);
  const v1 = pushVertex(b, pB.x, pB.y + h, pB.z, 0, 1, 0, hex);
  const v2 = pushVertex(b, pC.x, pC.y + h, pC.z, 0, 1, 0, hex);
  const v3 = pushVertex(b, pD.x, pD.y + h, pD.z, 0, 1, 0, hex);
  if (off0 > 0) pushQuad(b, v0, v1, v2, v3);
  else pushQuad(b, v3, v2, v1, v0);
}

function roofQuad(
  b: Builder,
  s0: Station,
  s1: Station,
  off0: number,
  off1: number,
  h: number,
  hex: number,
): void {
  surfacePoint(s0, -off0, pA);
  surfacePoint(s1, -off1, pB);
  surfacePoint(s1, off1, pC);
  surfacePoint(s0, off0, pD);
  // Downward normal: the roof is only ever seen from underneath.
  const v0 = pushVertex(b, pA.x, pA.y + h, pA.z, 0, -1, 0, hex);
  const v1 = pushVertex(b, pB.x, pB.y + h, pB.z, 0, -1, 0, hex);
  const v2 = pushVertex(b, pC.x, pC.y + h, pC.z, 0, -1, 0, hex);
  const v3 = pushVertex(b, pD.x, pD.y + h, pD.z, 0, -1, 0, hex);
  pushQuad(b, v3, v2, v1, v0);
}

function emitStartLine(b: Builder, stations: Station[], theme: Theme): void {
  const m = stations.length;
  const width = 1.2;
  const rings = Math.max(2, Math.round(width / CONFIG.track.stationSpacing) + 1);
  const squares = 12;
  for (let r = 0; r < rings - 1; r++) {
    const s0 = stations[r % m]!;
    const s1 = stations[(r + 1) % m]!;
    for (let c = 0; c < squares; c++) {
      const f0 = -1 + (2 * c) / squares;
      const f1 = -1 + (2 * (c + 1)) / squares;
      const hex = (r + c) % 2 === 0 ? theme.ink : theme.kerbA;
      band(
        b,
        s0,
        s1,
        f0 * s0.halfWidth,
        f0 * s1.halfWidth,
        f1 * s0.halfWidth,
        f1 * s1.halfWidth,
        hex,
      );
      // Lift the line a hair above the road so it does not z-fight with it.
      // 6 mm: enough at our near/far ratio, small enough that a wheel never
      // reads it as a bump (the *physics* never sees this — it is mesh-only).
      const n = b.pos.length;
      for (let k = n - 12; k < n; k += 3) b.pos[k + 1] = b.pos[k + 1]! + 0.006;
    }
  }
}
