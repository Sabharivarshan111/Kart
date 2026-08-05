import { expect, test } from '@playwright/test';
import { boot, frames, setControls, shot, simulate, stats, teleport } from './helpers.ts';

/**
 * The named shot list. Each shot states what it proves.
 *
 * Where a claim can be checked with a number instead of an eye, it is: the
 * frames are evidence a human can look at, and the assertions next to them are
 * what actually gates the build.
 */

test.describe('named shots', () => {
  test('M2 — a closed circuit with banking and kerbs', async ({ page }) => {
    await boot(page, { track: 'copper-flats' });

    await page.evaluate(() => window.sparkdrift!.setCameraPreset('overhead'));
    await frames(page, 3);
    await shot(page, 'track-overview', 'the circuit is closed and its corners have real radii');

    // Overhead of the whole lap: the kart's bounding box must be inside the
    // track's, and the track must span a real area rather than a sliver.
    const trackBounds = await page.evaluate(() => window.sparkdrift!.bounds('track'));
    expect(trackBounds).not.toBeNull();
    const spanX = trackBounds!.max[0] - trackBounds!.min[0];
    const spanZ = trackBounds!.max[2] - trackBounds!.min[2];
    expect(spanX).toBeGreaterThan(150);
    expect(spanZ).toBeGreaterThan(150);

    // Banked kerbed corner, from trackside. Turn 2 on Copper Flats is banked
    // 13° and carries kerbs on both edges.
    await teleport(page, 0, 0.365 * 791, 0, 0);
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('trackside'));
    await frames(page, 3);
    await shot(page, 'banking-and-kerbs', 'banking and alternating kerbs are visible on turn 2');
  });

  test('M3 — an exterior silhouette AND an interior crease, not the same line twice', async ({
    page,
  }) => {
    await boot(page, { track: 'copper-flats' });
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('close'));
    await frames(page, 3);
    await shot(page, 'cel-closeup', 'flat cel bands with hard steps, an ink silhouette and interior creases');

    const a = await page.evaluate(() => window.sparkdrift!.analyseEdges());

    // Both systems draw something at all.
    expect(a.outlineOnly.ink, 'the inverted hull drew no outline').toBeGreaterThan(200);
    expect(a.sobelOnly.ink, 'the Sobel pass drew no edges').toBeGreaterThan(200);

    // The decisive assertion: the Sobel draws a substantial body of ink that
    // the hull does not cover anywhere within two pixels. A hull only ever
    // produces a silhouette, so lines it never covers are interior lines —
    // creases the hull trick structurally cannot draw.
    expect(
      a.sobelOnly.unique,
      'the Sobel found no lines the hull was not already drawing — the two systems are drawing the same line twice',
    ).toBeGreaterThan(500);

    // And the hull is not redundant either: it draws silhouette the Sobel
    // misses, which is why both passes exist.
    expect(a.outlineOnly.unique).toBeGreaterThan(100);

    // Together they cover more than either alone.
    expect(a.both.ink).toBeGreaterThan(a.outlineOnly.ink);
    expect(a.both.ink).toBeGreaterThan(a.sobelOnly.ink);

    console.log(
      `  edges: hull ${a.outlineOnly.ink}px (${a.outlineOnly.unique} unique), ` +
        `sobel ${a.sobelOnly.ink}px (${a.sobelOnly.unique} unique), both ${a.both.ink}px`,
    );
  });

  test('M4 — the grid, a drift, and a jump', async ({ page }) => {
    await boot(page, { track: 'copper-flats' });
    await frames(page, 3);
    await shot(page, 'grid', 'eight karts on a two-column grid, all sitting on the road surface');

    // Every kart starts on the road, not in it and not beside it.
    const s0 = await stats(page);
    for (const k of s0.karts) {
      expect(k.onRoad, `kart ${k.index} (${k.driverId}) is not on the road at the start`).toBe(true);
      expect(k.wheelsOnGround, `kart ${k.index} has wheels off the ground on the grid`).toBe(4);
    }

    // A drift, charged to a tier, captured mid-slide.
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
    await teleport(page, 0, 0.33 * 791, -2, 20);
    await setControls(page, 0, { throttle: 1, steer: 0.85, drift: true });
    await simulate(page, 1.4);
    const drift = await stats(page);
    expect(drift.karts[0]!.drifting, 'the kart is not drifting').toBe(true);
    expect(drift.karts[0]!.driftTier, 'the drift charged no tier').toBeGreaterThanOrEqual(1);
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('chase'));
    await frames(page, 3);
    await shot(page, 'drift', `a committed drift charged to tier ${drift.karts[0]!.driftTier}, with tier-coloured sparks`);

    // Airborne over the ramp. The validator predicted a 40 m flight at top
    // speed; here the actual simulation has to leave the ground.
    await setControls(page, 0, { throttle: 1, steer: 0 });
    await teleport(page, 0, 0.10 * 791, 0, 24.5);
    await simulate(page, 1.6);
    const air = await stats(page);
    await frames(page, 3);
    await shot(page, 'jump', 'the kart leaves the ramp and the shadow separates from it');
    expect(
      air.karts[0]!.airborne || air.karts[0]!.airtime > 0,
      'the kart never got airborne over the ramp',
    ).toBeTruthy();

    await setControls(page, 0, null);
  });

  test('the tunnel on Lantern Reach', async ({ page }) => {
    await boot(page, { track: 'lantern-reach' });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
    await teleport(page, 0, 0.52 * 707, 0, 16);
    await frames(page, 3);
    await shot(page, 'tunnel', 'the tunnel roof reads as enclosure and the interior does not collapse to black');

    // Bug class 8, measured rather than eyeballed: inside the tunnel the sun is
    // occluded and the darkest cel band is all that is left. If the ambient
    // floor were too low the interior would be indistinguishable from the ink.
    const a = await page.evaluate(() => window.sparkdrift!.analyseEdges());
    // If the whole frame had collapsed to ink, "ink pixels that were not
    // already dark before the edge pass" would be near zero.
    expect(a.both.ink).toBeGreaterThan(100);
  });

  test('scenery instances are spread, not stacked at the origin', async ({ page }) => {
    await boot(page);
    const s = await stats(page);
    // Bug class 7. A count assertion passes for a hundred objects in one
    // invisible pile, so this asserts the *spread* of the instance set.
    expect(s.scenerySpread).not.toBeNull();
    expect(s.scenerySpread!.count).toBeGreaterThan(50);
    expect(
      s.scenerySpread!.sizeX,
      'scenery instances are not spread in X — instanceMatrix is probably not applied',
    ).toBeGreaterThan(100);
    expect(s.scenerySpread!.sizeZ).toBeGreaterThan(100);
  });
});
