import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Lantern Reach — the tunnel.
 *
 * One idea: a long banked tunnel you enter blind and exit into a braking zone.
 * The banking inside carries more speed than feels safe, and because the roof
 * cuts the sun the cel bands flatten in there — which is exactly why this
 * theme's ambient floor is set higher than the others.
 */
export const LANTERN_REACH: TrackSpec = {
  id: 'lantern-reach',
  name: 'Lantern Reach',
  idea: 'A long banked tunnel entered blind and exited into the hardest braking zone on the cup.',
  vertices: [
    { x: -80, z: -90, radius: 26 },
    { x: 30, z: -110, radius: 34 },
    { x: 105, z: -35, radius: 30 },
    { x: 95, z: 55, radius: 28 },
    { x: 20, z: 120, radius: 36 },
    { x: -75, z: 105, radius: 30 },
    { x: -125, z: 20, radius: 34 },
  ],
  defaults: {
    halfWidth: 4.8,
    surface: SurfaceKind.Road,
    vergeSurface: SurfaceKind.Grass,
    wall: WallKind.Barrier,
  },
  // Measured vertex lap fractions on this geometry:
  //   v0 0.143  v1 0.297  v2 0.444  v3 0.570  v4 0.708  v5 0.841  v6 0.977
  stretches: [
    // --- The idea: the tunnel ----------------------------------------------
    // Enters just before turn 3 and runs through it. The banking inside carries
    // more speed than it feels like it should, and because you cannot see the
    // exit you have to trust it.
    { from: 0.400, to: 0.640, wall: WallKind.Tunnel },
    { from: 0.430, to: 0.610, bankDeg: 17 },
    { from: 0.390, to: 0.660, elevation: -2.4 },
    // Boost strip at the blind midpoint — reachable only if you are already
    // holding the inside line.
    { from: 0.505, to: 0.528, surface: SurfaceKind.Boost },

    // --- The braking zone the tunnel spits you into -------------------------
    { from: 0.660, to: 0.700, halfWidth: 6.2 },
    { from: 0.700, to: 0.760, halfWidth: 4.1 },

    // --- Elevation elsewhere, so the tunnel is a descent and not a hole ------
    { from: 0.180, to: 0.320, elevation: 2.6 },
    { from: 0.850, to: 0.960, elevation: 1.4 },

    // Sand on the outside of the fast opening sweep: running wide here is
    // survivable but slow, which is the trade this corner is for.
    { from: 0.100, to: 0.200, vergeSurface: SurfaceKind.Sand },
  ],
  theme: {
    name: 'lantern',
    // 22°: a low sun, which is the point — it is what makes the tunnel mouth
    // read as a hole rather than as a change of surface.
    sunElevation: (22 * Math.PI) / 180,
    sunAzimuth: (205 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.09, lanes: [-3.0, -1.0, 1.0, 3.0] },
    { at: 0.34, lanes: [-2.5, 0, 2.5] },
    // Inside the tunnel: taking one here means picking a lane blind.
    { at: 0.47, lanes: [-2.5, 0, 2.5] },
    { at: 0.78, lanes: [-3.0, -1.0, 1.0, 3.0] },
  ],
  checkpoints: 7,
  direction: 1,
};
