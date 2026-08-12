import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Kayal Causeway — Kerala backwaters. The pinch.
 *
 * One idea: the whole lap is wide, flat, water-level causeway except for one
 * ferry jetty narrow enough that two karts do not fit through it side by side,
 * so every lap is decided by who arrives at the jetty in front.
 *
 * Everything else is built to feed that. The road is 12 m wide almost
 * everywhere — deliberately generous, because a pinch only reads as a pinch if
 * the rest of the track is roomy — and the corner before the jetty is a wide
 * banked sweep where two karts genuinely can go side by side, which is what
 * sets up the argument that the jetty then has to settle.
 *
 * The jetty itself is the only place on the track with a boost strip on its
 * exit: winning the pinch pays twice.
 */
export const KAYAL_CAUSEWAY: TrackSpec = {
  id: 'kayal-causeway',
  name: 'Kayal Causeway',
  idea: 'Every lap is settled at one ferry jetty too narrow for two karts abreast.',
  vertices: [
    { x: -70, z: -110, radius: 32 },
    { x: 70, z: -110, radius: 32 },
    { x: 120, z: -20, radius: 40 },
    { x: 100, z: 90, radius: 35 },
    { x: 0, z: 140, radius: 45 },
    { x: -100, z: 95, radius: 35 },
    { x: -125, z: 0, radius: 40 },
  ],
  defaults: {
    halfWidth: 6.0,
    surface: SurfaceKind.Road,
    // Paddy bund on both sides: slow, survivable, and the reason running wide
    // here is a mistake rather than a disaster.
    vergeSurface: SurfaceKind.Grass,
    wall: WallKind.Barrier,
  },
  // Lap 780 m. Vertex lap fractions measured by tools/validate-tracks.mts on
  // this exact geometry:
  //   v0 0.136  v1 0.310  v2 0.440  v3 0.580  v4 0.720  v5 0.857  v6 0.980
  // Every stretch below is placed against those numbers rather than guessed.
  stretches: [
    // --- The wide banked sweep that sets up the argument --------------------
    // v2 at 0.440. Banked only 7°: enough to hold two lines, not enough to make
    // the outside line free.
    { from: 0.380, to: 0.470, bankDeg: 7 },
    { from: 0.360, to: 0.500, halfWidth: 7.6 },

    // --- The idea: the jetty ------------------------------------------------
    // The funnel. 7.6 m of road narrowing to 3.4 m over 30 m of approach, so
    // the decision is made before the pinch rather than in it.
    { from: 0.500, to: 0.552, halfWidth: 7.6, rampMetres: 12 },
    // 3.4 m half-width is 6.8 m of road for two 1.28 m karts — they fit
    // geometrically and cannot fit at racing speed, which is the whole point.
    // The validator's floor is 2.05 m; this is comfortably above it and still
    // half the width of the rest of the lap.
    { from: 0.556, to: 0.616, halfWidth: 3.4, rampMetres: 14 },
    // The jetty deck sits 1.1 m above the water. Ramped over 22 m at each end
    // so it is a bridge deck, not a kerb: at the default blend this was a 9°
    // step that unloaded the rear axle exactly where the track is narrowest.
    { from: 0.540, to: 0.640, elevation: 1.1, rampMetres: 22 },

    // Boost strip on the jetty exit. Reachable by whoever got through first,
    // which is the second half of the prize.
    { from: 0.630, to: 0.652, surface: SurfaceKind.Boost },

    // --- Widening again, so the pass back is possible ------------------------
    { from: 0.660, to: 0.760, halfWidth: 7.0 },

    // Water on the outside of the long left after the jetty: the verge here is
    // silt rather than paddy bund, and it costs a second.
    { from: 0.690, to: 0.790, vergeSurface: SurfaceKind.Sand },

    // --- Gentle profile elsewhere. This is a backwater; nothing here climbs. --
    { from: 0.080, to: 0.230, elevation: 0.8, rampMetres: 40 },
    { from: 0.830, to: 0.960, elevation: 0.6, rampMetres: 30 },
  ],
  theme: {
    name: 'kayal',
    // 28° and nearly due east: a low-ish morning sun raked across the water so
    // the causeway's own banking casts along the road rather than down it.
    sunElevation: (28 * Math.PI) / 180,
    sunAzimuth: (100 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    // Nothing inside the pinch. A box you cannot avoid while threading a 6.8 m
    // gap is a tax, not a decision.
    { at: 0.07, lanes: [-3.6, -1.2, 1.2, 3.6] },
    { at: 0.24, lanes: [-3.0, 0, 3.0] },
    { at: 0.44, lanes: [-3.6, -1.2, 1.2, 3.6] },
    { at: 0.70, lanes: [-3.0, 0, 3.0] },
    { at: 0.90, lanes: [-3.6, -1.2, 1.2, 3.6] },
  ],
  checkpoints: 8,
  direction: 1,
};
