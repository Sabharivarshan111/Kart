import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Snowline Pass — the Himalaya. The ledge.
 *
 * One idea: the summit straight ends in a rock ledge you jump, and the entire
 * 13 m descent into the valley is waiting for whoever lands it flat.
 *
 * That is a jump whose *reward* is downstream rather than at the landing. A bad
 * landing keeps 72% of its speed (CONFIG.kart.air.landingBadSpeedKeep); a flat
 * one is worth 0.35 s of boost. Neither number is large on its own. What makes
 * the ledge decide the lap is that it is immediately followed by 170 m of
 * descent, where the speed you land with compounds instead of decaying.
 *
 * Take-off geometry: 4.0 m of climb over a 22 m ramp. The validator's ballistic
 * probe flies it against the real surface query at five speeds and measures a
 * 13.6° separation at u=184 m, then 10.6 m of flight at 20 m/s, 40.4 m at top
 * speed and 64.8 m on a tier-3 boost — all three landing on road. That 6×
 * spread between "rolled over it" and "jumped it" is what makes the boost strip
 * before it worth taking. The landing zone is widened to 7.8 m for the same
 * reason it is on every jump: one that demands a metre-accurate landing is a
 * memory test, not a driving one.
 *
 * The verge is packed snow the whole way round (the theme's `sand` slot), so
 * every mistake on this track is the same mistake.
 */
export const SNOWLINE_PASS: TrackSpec = {
  id: 'snowline-pass',
  name: 'Snowline Pass',
  idea: 'A ledge at the summit, and the whole descent to the valley waiting for whoever lands it flat.',
  vertices: [
    { x: -95, z: -125, radius: 34 },
    { x: 85, z: -130, radius: 38 },
    { x: 140, z: -30, radius: 34 },
    { x: 110, z: 70, radius: 32 },
    { x: 15, z: 135, radius: 40 },
    { x: -90, z: 110, radius: 32 },
    { x: -150, z: 10, radius: 36 },
  ],
  defaults: {
    halfWidth: 5.4,
    surface: SurfaceKind.Road,
    // Packed snow at the shoulder. Ploughed roads on a pass do not have a soft
    // option and neither does this one.
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap 866 m — the longest track in the game. Measured vertex lap fractions on
  // this exact geometry:
  //   v0 0.144  v1 0.346  v2 0.474  v3 0.594  v4 0.725  v5 0.848  v6 0.980
  // The summit straight runs v0 → v1, roughly 0.19 → 0.31, and the ledge is on
  // it. Everything below is placed against those numbers rather than guessed.
  stretches: [
    // --- The descent the ledge feeds ----------------------------------------
    // 13 m down into the valley and back up to the pass, over a 110 m ramp at
    // each end: 10.7° peak grade. The stations outside this stretch are the
    // summit plateau at 0, which is why the elevation closes across the start
    // line with no step.
    { from: 0.360, to: 0.950, elevation: -13.0, rampMetres: 110 },

    // --- The idea: the ledge -------------------------------------------------
    // The two stretches deliberately overlap. A single stretch cannot make a
    // sharp crest — its blend ramps are symmetric and the middle is flat, which
    // gives a hump, and a hump launches you flat. Dropping a falling stretch
    // onto the tail of the rising one puts the fall *inside* the flat top.
    { from: 0.196, to: 0.256, elevation: 4.0, rampMetres: 22, jump: true },
    { from: 0.240, to: 0.292, elevation: -1.4, rampMetres: 9 },
    // The landing.
    { from: 0.265, to: 0.350, halfWidth: 7.8, rampMetres: 22 },

    // Boost strip on the summit straight, feeding the ledge. Taking it turns
    // the ledge from "clear it" into "clear it and land flat", which is the
    // whole difference on this track.
    { from: 0.160, to: 0.184, surface: SurfaceKind.Boost },

    // --- The descent's two corners ------------------------------------------
    // v2 is the first corner after the drop and is banked, so it can be taken
    // flat by anyone still carrying the landing speed.
    { from: 0.440, to: 0.520, bankDeg: 14, rampMetres: 24 },
    // v3 is not banked and is narrower. This is where a good landing is
    // finally cashed in or thrown away.
    { from: 0.560, to: 0.630, halfWidth: 4.6, rampMetres: 16 },

    // --- The climb back ------------------------------------------------------
    // Wide through the valley floor hairpin, because the AI and the player are
    // both slowest here and it is the only place on the lap with real traffic.
    { from: 0.690, to: 0.780, halfWidth: 7.0, rampMetres: 22 },
    // Rock cutting on the final climb: narrow, walled, and the last chance to
    // be in front over the line.
    { from: 0.880, to: 0.955, halfWidth: 4.4, rampMetres: 18 },
    // Pine forest on the lower slopes — the only grass on the track, and the
    // only forgiving verge.
    { from: 0.640, to: 0.760, vergeSurface: SurfaceKind.Grass },
  ],
  theme: {
    name: 'snowline',
    // 41° and south-east: high enough for real shading on the snow, low enough
    // that the pines throw the long shadows a pass at altitude should have.
    sunElevation: (41 * Math.PI) / 180,
    sunAzimuth: (150 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.07, lanes: [-3.4, -1.1, 1.1, 3.4] },
    // Before the boost strip and the ledge, not after: the choice has to be
    // made with the jump still ahead of you.
    { at: 0.14, lanes: [-3.0, 0, 3.0] },
    { at: 0.40, lanes: [-3.4, -1.1, 1.1, 3.4] },
    { at: 0.72, lanes: [-3.0, 0, 3.0] },
    { at: 0.85, lanes: [-2.8, 0, 2.8] },
  ],
  checkpoints: 8,
  direction: 1,
};
