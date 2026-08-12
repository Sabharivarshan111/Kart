import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Stonestep Ghats — Varanasi at dawn. The staircase.
 *
 * One idea: the lap is a flight of stone steps — three drops down to the river
 * and three back up — and every drop is placed on a corner entry, so the kart
 * is unloading its rear axle at exactly the moment you want to turn.
 *
 * How the steps are authored, because it is not obvious from the data: a stretch
 * blends *towards* its elevation and back to whatever was there before at each
 * end. That makes a single stretch a bump, never a step. Three concentric
 * stretches nested inside one another give a staircase: the outermost holds -3
 * across most of the lap, the next holds -6.5 inside that, the innermost -10 in
 * the middle. Each inner stretch's ramps land on the previous one's plateau, so
 * what the kart drives is six discrete 3 m steps rather than one bowl.
 *
 * Peak gradient is 8.9° on the innermost step (amplitude × π/2 ÷ ramp), which is
 * under the separation threshold at every achievable speed — these are steps you
 * feel through the suspension, not ramps you fly off.
 */
export const STONESTEP_GHATS: TrackSpec = {
  id: 'stonestep-ghats',
  name: 'Stonestep Ghats',
  idea: 'Six stone steps down to the river and back, each one landing on a corner entry.',
  vertices: [
    { x: -95, z: -105, radius: 30 },
    { x: 60, z: -120, radius: 36 },
    { x: 130, z: -30, radius: 32 },
    { x: 105, z: 70, radius: 30 },
    { x: 10, z: 130, radius: 38 },
    { x: -90, z: 105, radius: 30 },
    { x: -140, z: 15, radius: 34 },
  ],
  defaults: {
    halfWidth: 5.2,
    surface: SurfaceKind.Road,
    // River silt at the edge of the stone. The ghats are swept, the margins are
    // not.
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap 803 m. Measured vertex lap fractions on this exact geometry:
  //   v0 0.137  v1 0.326  v2 0.465  v3 0.592  v4 0.730  v5 0.856  v6 0.982
  // The three drops are placed so their ramps land at 0.17, 0.31 and 0.44 —
  // the entries to v1, v2 and v3 respectively.
  stretches: [
    // --- The idea: the staircase --------------------------------------------
    // Step 1. Ramp 60 m for 3 m of drop: 4.5° peak, felt as a settle.
    { from: 0.100, to: 0.990, elevation: -3.0, rampMetres: 60 },
    // Step 2, nested inside step 1, so its ramp starts from -3 and ends at -3.
    { from: 0.240, to: 0.860, elevation: -6.5, rampMetres: 45 },
    // Step 3, the big one: 3.5 m over 35 m is 8.9°, the steepest thing on the
    // track and the reason the corner at v3 is the hardest on the lap.
    { from: 0.380, to: 0.700, elevation: -10.0, rampMetres: 35 },

    // --- Banking: the terraces tilt towards the water ------------------------
    // Positive bank on the two right-handers, so the low side of each terrace is
    // the inside. It is a small number on purpose — stone terraces are not
    // banked corners, they are flat slabs laid on a slope.
    { from: 0.420, to: 0.520, bankDeg: 10, rampMetres: 22 },
    { from: 0.600, to: 0.680, bankDeg: 7, rampMetres: 18 },

    // --- Width -------------------------------------------------------------
    // The bottom terrace is the widest thing on the track: it is the one place
    // where two karts unsettled by the same step can both survive it.
    { from: 0.480, to: 0.620, halfWidth: 7.0, rampMetres: 24 },
    // The last climb is the narrowest, and it is where the lap is lost.
    { from: 0.880, to: 0.950, halfWidth: 4.2, rampMetres: 14 },

    // Boost strip on the first terrace, before the drop into v2 — taking it
    // means arriving at the step faster, which is a genuine choice and not a
    // free gift.
    { from: 0.282, to: 0.304, surface: SurfaceKind.Boost },

    // Swept stone at the top of the ghats: the verge on the opening straight is
    // grass, the only forgiving margin on the lap.
    { from: 0.020, to: 0.110, vergeSurface: SurfaceKind.Grass },
  ],
  theme: {
    name: 'ghat',
    // 9° due east. Dawn over the river, which is the only time this place is
    // this colour, and low enough that the road renders at the ambient floor.
    sunElevation: (9 * Math.PI) / 180,
    sunAzimuth: (95 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.06, lanes: [-3.2, -1.1, 1.1, 3.2] },
    { at: 0.28, lanes: [-2.8, 0, 2.8] },
    { at: 0.52, lanes: [-4.0, -1.4, 1.4, 4.0] },
    { at: 0.72, lanes: [-2.8, 0, 2.8] },
    { at: 0.96, lanes: [-3.2, -1.1, 1.1, 3.2] },
  ],
  checkpoints: 8,
  direction: 1,
};
