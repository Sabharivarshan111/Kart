import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Nightshift Circuit — Bengaluru after midnight. All junctions, no corners.
 *
 * One idea: every corner on this track is a square city-block junction of 15 m
 * radius, so there is no sweeper anywhere to carry speed through — the entire
 * lap is braking, rotating and getting back on the throttle, eight times.
 *
 * The number that makes it work: a 15 m radius is takeable at
 * sqrt(1.55 × 9.81 × 15) ≈ 15.1 m/s, which is 62% of top speed. Every junction
 * therefore demands a real braking event from a real straight, and the straights
 * between them are 60–140 m — long enough to reach top speed and short enough
 * that you are still braking when you get there.
 *
 * The only relief is the flyover at the end of the lap, which is also the only
 * place the track goes anywhere vertically.
 */
export const NIGHTSHIFT_CIRCUIT: TrackSpec = {
  id: 'nightshift-circuit',
  name: 'Nightshift Circuit',
  idea: 'Eight square block junctions and not one sweeping corner, so the lap is won entirely on braking.',
  vertices: [
    { x: -70, z: -90, radius: 16 },
    { x: 45, z: -90, radius: 16 },
    { x: 45, z: -25, radius: 15 },
    { x: 110, z: -25, radius: 16 },
    { x: 110, z: 60, radius: 16 },
    { x: 20, z: 60, radius: 15 },
    { x: 20, z: 118, radius: 16 },
    { x: -95, z: 118, radius: 18 },
    { x: -95, z: -20, radius: 18 },
  ],
  defaults: {
    halfWidth: 5.2,
    surface: SurfaceKind.Road,
    // Pavement and kerbstone. Wet tarmac has nowhere soft to go.
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap 754 m, min radius 14.7 m. Measured vertex lap fractions on this exact
  // geometry:
  //   v0 0.093  v1 0.239  v2 0.316  v3 0.393  v4 0.496
  //   v5 0.608  v6 0.675  v7 0.819  v8 0.996
  // The widened braking zones below are each placed on the *approach* to one of
  // those numbers, not on the corner itself.
  stretches: [
    // --- The idea: braking zones, one per junction --------------------------
    // Widened before, narrow through. That shape is what makes a junction a
    // passing place rather than a queue: there is room to take a different line
    // into it and no room to be alongside in it.
    { from: 0.180, to: 0.232, halfWidth: 6.8, rampMetres: 14 },
    { from: 0.236, to: 0.322, halfWidth: 4.4, rampMetres: 12 },
    { from: 0.330, to: 0.386, halfWidth: 6.8, rampMetres: 14 },
    { from: 0.440, to: 0.492, halfWidth: 6.8, rampMetres: 14 },
    { from: 0.500, to: 0.612, halfWidth: 4.4, rampMetres: 16 },
    { from: 0.620, to: 0.672, halfWidth: 6.8, rampMetres: 14 },
    { from: 0.760, to: 0.815, halfWidth: 6.8, rampMetres: 14 },

    // --- The flyover ---------------------------------------------------------
    // 3.0 m up and back down over 110 m. Peak grade 9.7°: enough that the crest
    // goes light and the far side is out of sight, and not enough to separate —
    // at 24.5 m/s the vertical curvature needs 9.81 m/s² and produces 3.1.
    // It is deliberately not flagged as a jump, because the whole point of this
    // track is that nothing here is free.
    { from: 0.690, to: 0.900, elevation: 3.0, rampMetres: 30 },

    // The one boost strip, on the flyover descent where you are already fastest.
    // A boost placed where it is easy to use is a reward for the racing line;
    // one placed where it is hard is a puzzle, and this track has enough of
    // those.
    { from: 0.872, to: 0.896, surface: SurfaceKind.Boost },

    // Two junctions get a slight negative bank — city junctions crown for
    // drainage — which is why they are the two that catch people out.
    { from: 0.300, to: 0.340, bankDeg: -5, rampMetres: 12 },
    { from: 0.585, to: 0.630, bankDeg: -5, rampMetres: 12 },
  ],
  theme: {
    name: 'nightshift',
    // 7° is not a sun. It stands in for sodium and LED spill coming off the
    // buildings at street level, which is why it is cool, weak and nearly
    // horizontal. At this elevation the whole track renders at the theme's
    // ambient floor of 0.62 — the highest in the game, and the only reason the
    // tarmac is a colour instead of a hole.
    sunElevation: (7 * Math.PI) / 180,
    sunAzimuth: (20 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.05, lanes: [-3.2, -1.1, 1.1, 3.2] },
    { at: 0.20, lanes: [-3.6, 0, 3.6] },
    { at: 0.42, lanes: [-3.2, -1.1, 1.1, 3.2] },
    { at: 0.63, lanes: [-3.6, 0, 3.6] },
    { at: 0.78, lanes: [-3.2, -1.1, 1.1, 3.2] },
  ],
  checkpoints: 9,
  direction: 1,
};
