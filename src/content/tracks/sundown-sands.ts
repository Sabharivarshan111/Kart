import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Sundown Sands — Goa coast at dusk. The long one.
 *
 * One idea: a single 180° banked beach sweep long enough that a drift held all
 * the way through it charges to the top tier, and short enough that letting go
 * once loses the whole thing.
 *
 * The sweep is roughly 220 m of continuous 70 m-radius corner at 20° of bank.
 * Tier 3 needs 2.10 s of genuine sliding (CONFIG.kart.drift.tierTimes), which at
 * about 20 m/s through there is 42 m of the corner — so the corner is not the
 * constraint, holding it is. Everything before the sweep exists to arrive with
 * enough speed to be sliding at all, and the dune straight after it exists to
 * spend the boost on.
 *
 * The rest of the lap is deliberately plain. A track built around one corner
 * should not have a second one competing with it.
 */
export const SUNDOWN_SANDS: TrackSpec = {
  id: 'sundown-sands',
  name: 'Sundown Sands',
  idea: 'One 180° banked beach sweep long enough to charge a full drift through, if you never let go.',
  vertices: [
    { x: -130, z: -85, radius: 45 },
    { x: -20, z: -100, radius: 90 },
    { x: 105, z: -85, radius: 70 },
    { x: 105, z: 85, radius: 70 },
    { x: -130, z: 85, radius: 45 },
  ],
  defaults: {
    halfWidth: 6.4,
    surface: SurfaceKind.Road,
    // Beach on both sides the whole way round. There is no grass on this track.
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap 726 m. Measured vertex lap fractions on this exact geometry:
  //   v0 0.162  v1 0.306  v2 0.463  v3 0.661  v4 0.952
  // v2 and v3 are the two 90° halves of the single sweep: 70 m radius each with
  // a 30 m straight between them, which drives as one corner.
  stretches: [
    // --- The idea: the sweep -------------------------------------------------
    // Bank rises before the corner and falls after it, over 34 m at each end,
    // because a step in bank at 24 m/s is a lane change you did not ask for.
    { from: 0.430, to: 0.700, bankDeg: 20, rampMetres: 34 },
    // Widened through the whole sweep. The drift needs somewhere to go: at the
    // default 6.4 m a tier-2 slide is already touching the outside barrier.
    { from: 0.420, to: 0.710, halfWidth: 8.2, rampMetres: 30 },
    // The sweep runs slightly downhill into the sea, which is what lets it be
    // taken flat. 1.6 m over the whole corner is a 1% grade — felt, not seen.
    { from: 0.400, to: 0.730, elevation: -1.6, rampMetres: 40 },

    // --- The run-up ----------------------------------------------------------
    // The kink at v1 is nearly straight (90 m radius). It exists so the entry to
    // the sweep is not taken from a straight line, which is what makes the first
    // half of the sweep a commitment instead of a turn-in.
    { from: 0.250, to: 0.330, halfWidth: 7.2 },
    // Boost strip before the entry: the drift wants speed, and this is where it
    // comes from.
    { from: 0.372, to: 0.396, surface: SurfaceKind.Boost },

    // --- The dune straight, where the tier-3 boost gets spent ----------------
    { from: 0.760, to: 0.900, elevation: 2.4, rampMetres: 36 },
    // Narrower over the dune crest, so a boost held too long runs out of road.
    { from: 0.800, to: 0.870, halfWidth: 5.2 },
  ],
  theme: {
    name: 'sundown',
    // 12° in the west. Below the 14.5° band boundary, so every horizontal
    // surface on this track renders at the theme's ambient floor — the reason
    // that floor is 0.52 rather than the 0.46 the daylight themes get away with.
    sunElevation: (12 * Math.PI) / 180,
    sunAzimuth: (265 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.05, lanes: [-3.8, -1.3, 1.3, 3.8] },
    { at: 0.25, lanes: [-3.2, 0, 3.2] },
    // On the entry to the sweep, offset to the outside: taking one costs you
    // the inside line into the corner the whole track is about.
    { at: 0.41, lanes: [1.0, 3.0, 5.0] },
    { at: 0.60, lanes: [-4.0, 0, 4.0] },
    { at: 0.86, lanes: [-2.6, 0, 2.6] },
  ],
  checkpoints: 8,
  direction: 1,
};
