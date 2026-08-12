import { SurfaceKind, WallKind } from '../../core/contracts.ts';
import type { TrackSpec } from '../../core/contracts.ts';

/**
 * Saltpan Mirage — the Rann of Kutch. Nothing to lean on.
 *
 * One idea: there is not a single wall on this track. On a white salt flat with
 * no elevation and no barriers, the only thing telling you where the road is, is
 * the painted kerb line — and the only thing punishing you for ignoring it is
 * the crust itself.
 *
 * That makes this the one track where the shortcut is bought rather than found.
 * The inside of the long right at v3 can be cut across the salt crust
 * (SurfaceKind.Sand: gripScale 0.44, rollScale 15 — fifteen times the rolling
 * resistance of road). Crossing 30 m of it from a standing 24 m/s loses far more
 * than the 18 m the cut saves. Crossing it inside a drift boost, which is what
 * the strip at 0.585 exists to give you, does not. The strip is on the outside
 * line, so taking the shortcut means committing to it two corners early.
 *
 * Everything is flat. Zero elevation stretches, zero banking. A mirage-flat
 * horizon is only mirage-flat if the road agrees.
 */
export const SALTPAN_MIRAGE: TrackSpec = {
  id: 'saltpan-mirage',
  name: 'Saltpan Mirage',
  idea: 'No walls and no hills: only a kerb line, and one shortcut across the crust you must buy with a boost.',
  vertices: [
    { x: -150, z: -70, radius: 60 },
    { x: 60, z: -120, radius: 55 },
    { x: 155, z: 0, radius: 50 },
    { x: 60, z: 120, radius: 55 },
    { x: -120, z: 105, radius: 50 },
    { x: -165, z: 20, radius: 45 },
  ],
  defaults: {
    halfWidth: 7.0,
    surface: SurfaceKind.Road,
    // Salt crust. Drivable and ruinous, which is exactly the texture this track
    // needs where every other track has a barrier.
    vergeSurface: SurfaceKind.Sand,
    // The whole idea, in one field. Beyond the crust there is nothing at all,
    // and the off-track grace period (1.6 s) is the only thing between a bad
    // corner and a respawn.
    wall: WallKind.Open,
  },
  // Lap 850 m — the longest on the cup. Measured vertex lap fractions on this
  // exact geometry:
  //   v0 0.084  v1 0.328  v2 0.497  v3 0.666  v4 0.873  v5 0.983
  stretches: [
    // --- The idea: the bought shortcut --------------------------------------
    // The strip sits on the *outside* of the v2 exit, 70 m before the crust cut
    // at v3. Taking it costs you the inside line into v2 and gains you the only
    // boost long enough to survive the crust.
    { from: 0.585, to: 0.612, surface: SurfaceKind.Boost },
    // The road opens to 10.5 m half-width through v3, so there is room to line
    // the cut up and room to come back onto the road after it. The verge stays
    // crust: widening the *road* here would turn the shortcut into a free line.
    { from: 0.625, to: 0.730, halfWidth: 10.5, rampMetres: 26 },

    // --- The corner that has to be honest ------------------------------------
    // v1 is the only place the corridor narrows. With no barrier anywhere, a
    // narrowing is the strongest signal the track has, so it is spent once.
    { from: 0.300, to: 0.370, halfWidth: 5.4, rampMetres: 20 },

    // A second crust margin, wider than the default verge, on the outside of
    // the fast v2. Running wide here does not end your race — it costs you two
    // seconds of wheelspin, which on a 90-second lap is worse.
    { from: 0.460, to: 0.540, halfWidth: 8.6, rampMetres: 22 },

    // The kerb line is doing all the work of a barrier, so the last third gets
    // an extra-wide painted margin to aim at through the low-contrast haze.
    { from: 0.880, to: 0.980, halfWidth: 8.0, rampMetres: 24 },
  ],
  theme: {
    name: 'saltpan',
    // 58°: high, hard and almost shadowless, which is what salt at midday is.
    // The road sits in the top cel band and the only shading on the track is the
    // sides of the cairns.
    sunElevation: (58 * Math.PI) / 180,
    sunAzimuth: (190 * Math.PI) / 180,
  },
  laps: 3,
  itemBoxes: [
    { at: 0.05, lanes: [-4.2, -1.4, 1.4, 4.2] },
    { at: 0.25, lanes: [-3.6, 0, 3.6] },
    { at: 0.45, lanes: [-4.2, -1.4, 1.4, 4.2] },
    // On the shortcut approach, on the inside — so the boost strip and the item
    // box are on opposite sides of the road and you cannot have both.
    { at: 0.60, lanes: [-4.0, -2.0] },
    { at: 0.80, lanes: [-3.6, 0, 3.6] },
  ],
  checkpoints: 8,
  direction: 1,
};
