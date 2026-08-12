import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Seawall Squall — Mumbai in the monsoon. No safe side.
 *
 * One idea: the sea wall runs down the outside of every corner and standing
 * water sits on the inside of every corner, so there is no direction in which
 * running wide is cheap — the racing line is the only line.
 *
 * Mechanically that is one default and one stretch type. The verge is silt
 * (SurfaceKind.Sand: gripScale 0.44, rollScale 15) the entire way round, and
 * the barrier is never open. The corner at v3 is off-camber on top of that,
 * which is the single nastiest place on the cup: a wet, negatively banked
 * right-hander with a wall on its outside.
 *
 * The road narrows twice rather than widening anywhere. That is the opposite of
 * every other track here and it is deliberate — this one is about restraint.
 */
export const SEAWALL_SQUALL: TrackSpec = {
  id: 'seawall-squall',
  name: 'Seawall Squall',
  idea: 'Sea wall outside every corner, standing water inside every corner, and no cheap way to run wide.',
  vertices: [
    { x: -110, z: -95, radius: 28 },
    { x: 35, z: -115, radius: 34 },
    { x: 120, z: -40, radius: 30 },
    { x: 95, z: 60, radius: 26 },
    { x: 0, z: 115, radius: 34 },
    { x: -95, z: 95, radius: 28 },
    { x: -135, z: 10, radius: 32 },
  ],
  defaults: {
    halfWidth: 5.0,
    surface: SurfaceKind.Road,
    // Standing water and silt. This is the whole track's thesis in one field.
    vergeSurface: SurfaceKind.Sand,
    wall: WallKind.Barrier,
  },
  // Lap 756 m. Measured vertex lap fractions on this exact geometry:
  //   v0 0.124  v1 0.313  v2 0.460  v3 0.594  v4 0.737  v5 0.864  v6 0.985
  stretches: [
    // --- The idea, sharpened: the off-camber corner --------------------------
    // v3 at 0.594. -9° of bank, which on a right-hander means the road falls
    // away from the corner. Ramped over 26 m: an off-camber section that
    // arrives as a step is not a corner, it is a trap.
    { from: 0.545, to: 0.650, bankDeg: -9, rampMetres: 26 },

    // --- The two pinches ----------------------------------------------------
    // Both sit at corner exits, where the temptation to use all the road is
    // strongest and where the sea wall is closest.
    { from: 0.280, to: 0.360, halfWidth: 4.2, rampMetres: 18 },
    { from: 0.700, to: 0.780, halfWidth: 4.2, rampMetres: 18 },

    // --- The flooded dip -----------------------------------------------------
    // 2.2 m down and back up over 150 m. Shallow enough that it never launches
    // anything (peak grade under 5°) and deep enough that the far side of it is
    // out of sight from the entry in this theme's fog.
    { from: 0.380, to: 0.520, elevation: -2.2, rampMetres: 30 },

    // A short rise onto the sea wall promenade for the last third, so the wall
    // is above the road and reads as containment rather than as a kerb.
    { from: 0.800, to: 0.960, elevation: 1.8, rampMetres: 34 },

    // The one boost strip. On the exit of the fast opening left, where the
    // water sheets off the camber — the only place on this track that gives
    // anything back.
    { from: 0.165, to: 0.188, surface: SurfaceKind.Boost },

    // The opening left is the one corner with a genuine kerb to lean on, so the
    // verge there is grass rather than silt. It is the track's single
    // concession and it is on lap one's first corner on purpose.
    { from: 0.090, to: 0.170, vergeSurface: SurfaceKind.Grass },
  ],
  theme: {
    name: 'squall',
    // 20° with the sun behind the storm. Above the first band boundary, so the
    // road is one band up from the floor — which is what stops an overcast
    // theme reading as a night theme.
    sunElevation: (20 * Math.PI) / 180,
    sunAzimuth: (230 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.08, lanes: [-3.0, -1.0, 1.0, 3.0] },
    { at: 0.26, lanes: [-2.6, 0, 2.6] },
    { at: 0.46, lanes: [-3.0, -1.0, 1.0, 3.0] },
    { at: 0.66, lanes: [-2.6, 0, 2.6] },
    { at: 0.90, lanes: [-3.0, -1.0, 1.0, 3.0] },
  ],
  checkpoints: 8,
  direction: 1,
};
