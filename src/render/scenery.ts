import * as THREE from 'three';
import { SceneryKit, type Theme } from '../core/palette.ts';
import { MeshBuilder } from './geombuild.ts';

/**
 * Roadside scenery kits.
 *
 * Every track names a kit in its theme (`Theme.sceneryKit`) and this module
 * builds it procedurally out of `MeshBuilder` primitives. There are no colour
 * literals here: every face takes one of the theme's own colours, so a kit is
 * automatically in-key with the track it stands beside.
 *
 * Two rules the whole file is shaped by:
 *
 * 1. **One geometry, many instances.** The kit is built once and drawn as a
 *    single `InstancedMesh`, so the triangle budget below is per *kit*, not per
 *    prop. Everything here is 60–200 triangles.
 * 2. **The placement band is part of the kit.** A palm 2 m from a Kerala bund
 *    and a salt cairn 30 m out on the Rann are the same code with different
 *    numbers, and the numbers are what make the place read. They live next to
 *    the geometry rather than in the renderer for that reason.
 *
 * The instanced set is asserted *spread* rather than counted (ARCHITECTURE.md
 * §6.4) — a count assertion passes for two hundred props in one invisible pile
 * at the origin, which is exactly what a missing `instanceMatrix` in the
 * hand-written vertex shader produces.
 */

export interface SceneryKitSpec {
  /** Metres outboard of the wall line for the near and far edge of the band the
   *  props are scattered in. A tight band reads as a street; a wide one reads as
   *  open country, and getting that wrong is most of the difference between a
   *  city track and a desert one. */
  minOffset: number;
  maxOffset: number;
  /** Uniform horizontal scale range. */
  scaleMin: number;
  scaleMax: number;
  /** Vertical scale range, applied on top of the uniform one. Trees want a
   *  wide spread here; built objects want almost none, because a lamp post
   *  half again as tall as its neighbour reads as a modelling error. */
  heightMin: number;
  heightMax: number;
  /** Maximum lean from vertical, radians. Grown things lean, built things do
   *  not. */
  tilt: number;
  /** Metres the prop is sunk into the ground, to hide the open bottom face on
   *  a verge that is not perfectly level. */
  sink: number;
  build(b: MeshBuilder, theme: Theme): void;
}

// Scratch objects. Kits are built once at world construction, but the matrix is
// composed per instance and there can be 260 of them.
const m4 = new THREE.Matrix4();
const euler = new THREE.Euler();

/** Coconut palm: a leaning tapered trunk with fronds radiating from the crown. */
function buildPalm(b: MeshBuilder, theme: Theme): void {
  // Trunk in three segments so the taper is a curve rather than a cone.
  b.box(0, 1.3, 0, 0.44, 2.6, 0.44, theme.scenery, 0.82, 0.82);
  b.box(0, 3.5, 0, 0.36, 1.8, 0.36, theme.scenery, 0.82, 0.82);
  b.box(0, 4.7, 0, 0.30, 0.8, 0.30, theme.scenery, 0.9, 0.9);
  // Seven fronds on a 5.1 m crown, each a thin blade pitched down 22°.
  for (let i = 0; i < 7; i++) {
    const yaw = (i / 7) * Math.PI * 2;
    euler.set(0, yaw, -0.38);
    m4.makeRotationFromEuler(euler);
    m4.setPosition(0, 5.15, 0);
    b.setTransform(m4);
    b.box(1.35, 0, 0, 2.7, 0.10, 0.62, theme.sceneryAlt, 0.25, 0.25);
    b.resetTransform();
  }
  // Nut cluster under the crown — small, but it is the thing that makes the
  // silhouette read as a coconut palm rather than as a generic frond tree.
  b.box(0, 4.95, 0, 0.62, 0.42, 0.62, theme.scenery);
}

/** Carved sandstone screen pillar with a domed chhatri cap. */
function buildJali(b: MeshBuilder, theme: Theme): void {
  b.box(0, 0.25, 0, 1.15, 0.5, 1.15, theme.sceneryAlt);
  b.box(0, 1.7, 0, 0.78, 2.4, 0.78, theme.scenery, 0.88, 0.88);
  // The jali screen itself: a slab beside the pillar, split into three panels
  // by two gaps, which is what gives the Sobel something to find at distance.
  for (let i = 0; i < 3; i++) {
    b.box(0.95, 1.15 + i * 0.72, 0, 0.14, 0.56, 1.5, theme.sceneryAlt);
  }
  // Chhatri: abacus, dome, finial.
  b.box(0, 3.02, 0, 1.25, 0.22, 1.25, theme.sceneryAlt);
  b.box(0, 3.42, 0, 0.95, 0.6, 0.95, theme.scenery, 0.45, 0.45);
  b.box(0, 3.86, 0, 0.16, 0.4, 0.16, theme.sceneryAlt);
}

/** Beach-shack parasol: a driftwood pole under a thatch pyramid. */
function buildParasol(b: MeshBuilder, theme: Theme): void {
  b.box(0, 1.15, 0, 0.16, 2.3, 0.16, theme.scenery);
  // The canopy is a box tapered almost to a point — the cheapest pyramid there
  // is, and at 12 triangles it is worth having 200 of them.
  b.box(0, 2.55, 0, 2.9, 0.62, 2.9, theme.sceneryAlt, 0.1, 0.1);
  b.box(0, 2.22, 0, 2.9, 0.1, 2.9, theme.sceneryAlt);
  // A windbreak panel at the base, so the prop has something at eye height for
  // a kart and does not read as floating.
  b.box(0, 0.42, 0.95, 2.1, 0.84, 0.12, theme.scenery);
}

/** Sea-wall lighting mast with a crossarm and two heads. */
function buildMast(b: MeshBuilder, theme: Theme): void {
  b.box(0, 0.25, 0, 0.86, 0.5, 0.86, theme.sceneryAlt);
  b.box(0, 2.9, 0, 0.34, 5.3, 0.34, theme.scenery, 0.62, 0.62);
  b.box(0, 5.5, 0, 2.3, 0.16, 0.16, theme.sceneryAlt);
  // The lamp heads take the wall accent rather than the scenery colour: in a
  // storm theme they are the only warm thing in the frame.
  b.box(-1.0, 5.28, 0, 0.46, 0.3, 0.56, theme.wallAccent);
  b.box(1.0, 5.28, 0, 0.46, 0.3, 0.56, theme.wallAccent);
}

/** Stone lamp column on a stepped plinth — the ghats in miniature. */
function buildGhatLamp(b: MeshBuilder, theme: Theme): void {
  // Three steps. The whole track is a staircase, so its scenery is too.
  b.box(0, 0.16, 0, 2.4, 0.32, 2.4, theme.sceneryAlt);
  b.box(0, 0.48, 0, 1.85, 0.32, 1.85, theme.scenery);
  b.box(0, 0.8, 0, 1.3, 0.32, 1.3, theme.sceneryAlt);
  b.box(0, 1.95, 0, 0.46, 2.0, 0.46, theme.scenery, 0.8, 0.8);
  b.box(0, 3.15, 0, 0.68, 0.78, 0.68, theme.wallAccent);
  b.box(0, 3.66, 0, 0.9, 0.24, 0.9, theme.sceneryAlt, 0.35, 0.35);
}

/** Stacked salt-block cairn. Deliberately low: on the Rann the horizon is the
 *  track, and a tall prop line would fence it in. */
function buildCairn(b: MeshBuilder, theme: Theme): void {
  b.box(0, 0.3, 0, 1.9, 0.6, 1.65, theme.scenery);
  b.box(0.12, 0.86, 0.06, 1.35, 0.52, 1.2, theme.sceneryAlt);
  b.box(-0.06, 1.28, -0.04, 0.95, 0.34, 0.88, theme.scenery);
  b.box(0.04, 1.58, 0, 0.55, 0.3, 0.5, theme.sceneryAlt);
}

/** Neon sign pylon on a gantry leg. */
function buildPylon(b: MeshBuilder, theme: Theme): void {
  b.box(0, 0.22, 0, 0.95, 0.44, 0.95, theme.scenery);
  b.box(0, 2.6, 0, 0.36, 4.9, 0.36, theme.scenery, 0.78, 0.78);
  b.box(0.75, 4.5, 0, 1.5, 0.14, 0.14, theme.sceneryAlt);
  b.box(1.55, 3.95, 0, 1.6, 2.5, 0.18, theme.sceneryAlt);
  // Two lit strips on the face of the board. These use the boost-strip and kerb
  // accent colours because they are the two most saturated entries a theme has,
  // and a neon sign that is not the brightest thing in a night frame is not a
  // neon sign.
  b.box(1.55, 4.62, 0.13, 1.15, 0.2, 0.06, theme.boostStrip);
  b.box(1.55, 3.34, 0.13, 1.15, 0.2, 0.06, theme.kerbB);
}

/** Conical deodar under snow. */
function buildPine(b: MeshBuilder, theme: Theme): void {
  b.box(0, 0.55, 0, 0.34, 1.1, 0.34, theme.scenery);
  b.box(0, 1.55, 0, 3.0, 1.5, 3.0, theme.scenery, 0.58, 0.58);
  b.box(0, 2.75, 0, 2.0, 1.4, 2.0, theme.scenery, 0.52, 0.52);
  // The top tier takes the lighter colour: snow settles on the crown, and a
  // solid dark cone against a bright sky is a silhouette rather than a tree.
  b.box(0, 3.85, 0, 1.25, 1.35, 1.25, theme.sceneryAlt, 0.16, 0.16);
}

const KITS: Record<SceneryKit, SceneryKitSpec> = {
  [SceneryKit.Palm]: {
    // Palms crowd the bund right up to the water's edge, so they start close.
    minOffset: 1.2,
    maxOffset: 15,
    scaleMin: 0.8,
    scaleMax: 1.35,
    heightMin: 0.85,
    heightMax: 1.4,
    tilt: 0.16,
    sink: 0.2,
    build: buildPalm,
  },
  [SceneryKit.Jali]: {
    // Tight: this is a street frontage, and a gap between the wall and the
    // buildings would make the old city read as a park.
    minOffset: 0.4,
    maxOffset: 4.5,
    scaleMin: 0.9,
    scaleMax: 1.3,
    heightMin: 0.95,
    heightMax: 1.5,
    tilt: 0,
    sink: 0.15,
    build: buildJali,
  },
  [SceneryKit.Parasol]: {
    minOffset: 2.5,
    maxOffset: 22,
    scaleMin: 0.85,
    scaleMax: 1.5,
    heightMin: 0.9,
    heightMax: 1.15,
    tilt: 0.11,
    sink: 0.1,
    build: buildParasol,
  },
  [SceneryKit.Mast]: {
    minOffset: 0.6,
    maxOffset: 5.5,
    scaleMin: 0.9,
    scaleMax: 1.15,
    heightMin: 0.95,
    heightMax: 1.25,
    tilt: 0,
    sink: 0.15,
    build: buildMast,
  },
  [SceneryKit.GhatLamp]: {
    minOffset: 0.8,
    maxOffset: 8,
    scaleMin: 0.85,
    scaleMax: 1.25,
    heightMin: 0.9,
    heightMax: 1.3,
    tilt: 0,
    sink: 0.25,
    build: buildGhatLamp,
  },
  [SceneryKit.Cairn]: {
    // The widest band in the game by a factor of two. On a salt flat the props
    // have to be genuinely far away or the scale of the place collapses.
    minOffset: 5,
    maxOffset: 55,
    scaleMin: 0.7,
    scaleMax: 2.2,
    heightMin: 0.8,
    heightMax: 1.6,
    tilt: 0.07,
    sink: 0.1,
    build: buildCairn,
  },
  [SceneryKit.Pylon]: {
    minOffset: 1.0,
    maxOffset: 10,
    scaleMin: 0.9,
    scaleMax: 1.7,
    heightMin: 0.9,
    heightMax: 1.8,
    tilt: 0,
    sink: 0.15,
    build: buildPylon,
  },
  [SceneryKit.Pine]: {
    minOffset: 1.5,
    maxOffset: 26,
    scaleMin: 0.7,
    scaleMax: 1.6,
    heightMin: 0.8,
    heightMax: 1.9,
    tilt: 0.09,
    sink: 0.3,
    build: buildPine,
  },
};

export function sceneryKitSpec(kit: SceneryKit): SceneryKitSpec {
  const spec = KITS[kit];
  if (!spec) throw new Error(`render/scenery: unknown scenery kit "${kit}"`);
  return spec;
}

/** Build the kit's geometry for a theme. One call per world. */
export function buildSceneryGeometry(theme: Theme): THREE.BufferGeometry {
  const b = new MeshBuilder();
  sceneryKitSpec(theme.sceneryKit).build(b, theme);
  return b.build();
}
