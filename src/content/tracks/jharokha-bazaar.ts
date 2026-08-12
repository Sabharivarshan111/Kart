import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Jharokha Bazaar — Jaipur old city. The arcade.
 *
 * One idea: a third of the lap runs inside a covered sandstone bazaar arcade
 * with no room to pass, so the only two overtaking spots on the track are the
 * gates at each end of it.
 *
 * The arcade is narrow (4.0 m half-width against 4.6 m elsewhere), unbanked and
 * lit only by what gets past the jali screens — the theme's ambient floor is the
 * lowest in the game and it survives only because the sun is 66° up, which is
 * the trade this track is making. The two gates are widened to 6.4 m so the
 * approach to each is a real braking duel rather than a queue.
 *
 * The corner at v3 is the notch: the street doubles back into the bazaar and
 * the wall on the outside is a solid sandstone frontage.
 */
export const JHAROKHA_BAZAAR: TrackSpec = {
  id: 'jharokha-bazaar',
  name: 'Jharokha Bazaar',
  idea: 'A covered bazaar arcade with no room to pass, so the whole race happens at its two gates.',
  vertices: [
    { x: -60, z: -80, radius: 20 },
    { x: 55, z: -85, radius: 22 },
    { x: 95, z: -25, radius: 18 },
    { x: 60, z: 35, radius: 20 },
    { x: 90, z: 95, radius: 22 },
    { x: -10, z: 120, radius: 26 },
    { x: -95, z: 70, radius: 24 },
    { x: -100, z: -20, radius: 22 },
  ],
  defaults: {
    halfWidth: 4.6,
    surface: SurfaceKind.Road,
    // Dust and swept sand at the edge of the street. Punishing on purpose:
    // there is nowhere on this track where running wide is free.
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap 661 m. Measured vertex lap fractions on this exact geometry:
  //   v0 0.097  v1 0.268  v2 0.373  v3 0.476  v4 0.564
  //   v5 0.708  v6 0.854  v7 0.989
  stretches: [
    // --- The idea: the arcade ----------------------------------------------
    // Enters just after v1 and runs through v2 and the notch at v3, coming out
    // before v4. That is 0.31 → 0.53, about a third of the lap.
    { from: 0.310, to: 0.530, wall: WallKind.Tunnel },
    { from: 0.325, to: 0.515, halfWidth: 4.0 },
    // The arcade floor is a shallow dish — it is a street that drains — which
    // also stops the roof reading as a flat lid.
    { from: 0.300, to: 0.545, elevation: -1.4, rampMetres: 26 },

    // The two gates. Widened well before the mouth, so the pass is completed on
    // the approach and not attempted inside.
    { from: 0.240, to: 0.306, halfWidth: 6.4, rampMetres: 16 },
    { from: 0.534, to: 0.600, halfWidth: 6.4, rampMetres: 16 },

    // A boost strip halfway down the arcade, on the line you can only hold if
    // you got in first.
    { from: 0.414, to: 0.436, surface: SurfaceKind.Boost },

    // --- Outside the arcade -------------------------------------------------
    // v0 is the fast entry off the main street: banked slightly into the
    // sandstone frontage so it can be taken without lifting.
    { from: 0.060, to: 0.135, bankDeg: 9 },
    // The old city climbs away from the gate. 2.2 m over the back of the lap,
    // ramped long so the tunnel mouth is level with what leads into it.
    { from: 0.620, to: 0.860, elevation: 2.2, rampMetres: 34 },
    // Final street: narrow, unbanked, straight into the start line. Losing the
    // arcade exit is still costing you here.
    { from: 0.900, to: 0.960, halfWidth: 4.0 },
  ],
  theme: {
    name: 'jharokha',
    // 66°: near-overhead. Chosen so the road sits in the top cel band outside
    // and drops two bands under the arcade roof — the light change is what
    // makes the gate read as a threshold rather than a change of texture.
    sunElevation: (66 * Math.PI) / 180,
    sunAzimuth: (160 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.06, lanes: [-2.8, -0.9, 0.9, 2.8] },
    { at: 0.22, lanes: [-2.6, 0, 2.6] },
    // Inside the arcade, on a 4.0 m half-width: three lanes and no room to
    // change your mind.
    { at: 0.44, lanes: [-2.2, 0, 2.2] },
    { at: 0.64, lanes: [-2.8, -0.9, 0.9, 2.8] },
    { at: 0.86, lanes: [-2.6, 0, 2.6] },
  ],
  checkpoints: 8,
  direction: 1,
};
