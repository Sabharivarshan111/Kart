import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Copper Flats — the long jump.
 *
 * One idea: a ramp on the back straight that throws you over a dip, where the
 * landing rewards being flat and the run-up rewards arriving on a drift boost.
 * Everything else on the lap exists to set that up: a fast opening sweep so you
 * carry speed into it, and a tight final corner so a bad landing costs you the
 * lap rather than a tenth.
 *
 * The shortcut is the inside of turn 4: the verge there is grass rather than
 * sand and the corridor is wide enough to cut it, but grass costs about as much
 * as the cut saves — unless you arrive already boosting.
 */
export const COPPER_FLATS: TrackSpec = {
  id: 'copper-flats',
  name: 'Copper Flats',
  idea: 'A long jump on the back straight that pays for a boosted run-up.',
  vertices: [
    { x: -60, z: -120, radius: 30 },
    { x: 60, z: -120, radius: 30 },
    { x: 110, z: -40, radius: 35 },
    { x: 110, z: 60, radius: 30 },
    { x: 40, z: 130, radius: 40 },
    { x: -60, z: 130, radius: 35 },
    { x: -120, z: 40, radius: 40 },
    { x: -120, z: -50, radius: 35 },
  ],
  defaults: {
    halfWidth: 5.0,
    surface: SurfaceKind.Road,
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap fractions of the authored vertices, as measured by
  // `tools/validate-tracks.mts` on this exact geometry:
  //   v0 0.099  v1 0.248  v2 0.365  v3 0.490
  //   v4 0.613  v5 0.737  v6 0.871  v7 0.984
  // Every stretch below is placed against those numbers rather than guessed.
  stretches: [
    // Boost strip on the exit of turn 1, feeding the ramp. Taking it is what
    // turns the jump from "clear it" into "clear it and land flat".
    { from: 0.104, to: 0.122, surface: SurfaceKind.Boost },

    // --- The idea: the ramp and the dip it throws you over ------------------
    // The ramp climbs to 3.6 m and the road falls away to -0.6 m immediately
    // after, so the crest is a genuine take-off rather than a bump. Take-off
    // angle and landing distance are measured by the validator's ballistic
    // simulation at five speeds, not eyeballed.
    // The two stretches deliberately overlap. A single stretch cannot produce a
    // sharp crest, because the blend ramps are capped at a quarter of the span
    // at each end and the middle is flat — that gives a hump, and a hump
    // launches you flat. Overlapping a falling stretch onto the tail of the
    // rising one puts the fall *inside* the flat top, which is what makes the
    // crest sharp enough to separate from.
    // 22 m of ramp for a 4 m climb peaks at 16°, and the validator's ballistic
    // probe says that is a 40 m flight at top speed and 68 m on a tier-3 boost.
    // The default 12 m blend peaked at 31° and threw the kart 102 m, clear over
    // the landing and into the next corner's barrier.
    { from: 0.115, to: 0.180, elevation: 4.0, rampMetres: 22, jump: true },
    { from: 0.168, to: 0.215, elevation: -1.4, rampMetres: 8 },
    // The landing zone is widened, because a jump that demands a metre-accurate
    // landing is a memory test rather than a driving one.
    { from: 0.180, to: 0.250, halfWidth: 7.0 },

    // --- Turn 2: banked, so it can be taken flat if you commit --------------
    { from: 0.330, to: 0.400, bankDeg: 13 },
    { from: 0.300, to: 0.430, elevation: 1.8 },

    // --- Turn 3 into the climb ---------------------------------------------
    { from: 0.455, to: 0.530, bankDeg: 8, elevation: 3.2 },

    // --- The shortcut that costs something ---------------------------------
    // The inside of turn 4 is grass rather than sand and the corridor is wide
    // enough to cut across it. Grass costs about as much as the cut saves —
    // so it is only worth taking if you arrive already boosting.
    {
      from: 0.578,
      to: 0.652,
      halfWidth: 7.6,
      vergeSurface: SurfaceKind.Grass,
      elevation: 2.0,
    },

    // --- Descent back to the start line -------------------------------------
    { from: 0.700, to: 0.800, elevation: 0.8 },
    // Final corner: tight, unbanked and narrow. A bad landing on the jump is
    // still costing you time when you arrive here.
    { from: 0.855, to: 0.905, halfWidth: 4.2 },
  ],
  theme: {
    name: 'copper',
    // 34° sun: high enough that the road sits in the second cel band on the
    // straights and drops to the first through the corners, which is what makes
    // the banking legible.
    sunElevation: (34 * Math.PI) / 180,
    sunAzimuth: (125 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    // Placed on approaches rather than in braking zones: a box you have to
    // choose to take is a decision, one you cannot avoid is a tax.
    { at: 0.06, lanes: [-3.0, -1.0, 1.0, 3.0] },
    { at: 0.29, lanes: [-2.6, 0, 2.6] },
    { at: 0.52, lanes: [-3.0, -1.0, 1.0, 3.0] },
    { at: 0.69, lanes: [-2.6, 0, 2.6] },
    { at: 0.82, lanes: [-3.0, -1.0, 1.0, 3.0] },
  ],
  checkpoints: 8,
  direction: 1,
};
