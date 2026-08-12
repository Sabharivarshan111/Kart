import { expect, test } from '@playwright/test';
import { boot, frames, setControls, shot, simulate, stats, teleport } from './helpers.ts';

/**
 * The named shot list. Each shot states what it proves.
 *
 * Where a claim can be checked with a number instead of an eye, it is: the
 * frames are evidence a human can look at, and the assertions next to them are
 * what actually gates the build.
 */

/** Lap lengths as measured by the geometry validator, not as authored. */
const TRACKS = [
  { id: 'kayal-causeway', lap: 780, where: 'a Kerala backwater causeway' },
  { id: 'jharokha-bazaar', lap: 661, where: 'a pink-sandstone bazaar arcade' },
  { id: 'sundown-sands', lap: 726, where: 'a Goan beach road at dusk' },
  { id: 'seawall-squall', lap: 756, where: 'a Mumbai sea wall in monsoon' },
  { id: 'stonestep-ghats', lap: 803, where: 'river ghats at dawn' },
  { id: 'saltpan-mirage', lap: 850, where: 'the white salt flat of the Rann' },
  { id: 'nightshift-circuit', lap: 754, where: 'a neon city circuit at night' },
  { id: 'snowline-pass', lap: 866, where: 'a Himalayan pass above the treeline' },
];

const DEFAULT = TRACKS[0]!;

test.describe('named shots', () => {
  // One establishing frame per track. This is the single most useful thing in
  // the suite: a first-party bar means a frame identifies its place without a
  // caption, and eight frames side by side is how that gets judged.
  for (const t of TRACKS) {
    test(`establishing frame — ${t.id}`, async ({ page }) => {
      await boot(page, { track: t.id });
      await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
      // A quarter of the way round, at speed, from the chase camera: the view
      // the player actually spends the race looking at.
      await teleport(page, 0, 0.25 * t.lap, 0, 18);
      // Only long enough for the suspension to settle. Any further and the kart
      // runs wide on the tighter tracks with nobody steering it, and the shot
      // stops being an establishing frame and starts being an off-road frame.
      await simulate(page, 0.15);
      await frames(page, 4);
      await shot(page, `track-${t.id}`, `${t.where} — readable as its own place`);

      const s = await stats(page);
      expect(s.karts[0]!.onRoad, 'the camera subject is off the road').toBe(true);
      // Nothing should be so dark that the frame has collapsed.
      const a = await page.evaluate(() => window.sparkdrift!.analyseEdges());
      expect(a.both.ink, 'the frame has no drawn line in it at all').toBeGreaterThan(100);
    });
  }

  test('the circuit closes and carries banking and kerbs', async ({ page }) => {
    await boot(page, { track: DEFAULT.id });
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('overhead'));
    await frames(page, 3);
    await shot(page, 'track-overview', 'the circuit is closed and its corners have real radii');

    const trackBounds = await page.evaluate(() => window.sparkdrift!.bounds('track'));
    expect(trackBounds).not.toBeNull();
    expect(trackBounds!.max[0] - trackBounds!.min[0]).toBeGreaterThan(150);
    expect(trackBounds!.max[2] - trackBounds!.min[2]).toBeGreaterThan(150);

    await teleport(page, 0, 0.5 * DEFAULT.lap, 0, 0);
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('trackside'));
    await frames(page, 3);
    await shot(page, 'banking-and-kerbs', 'kerbs and the corridor edge from trackside');
  });

  test('an exterior silhouette AND an interior crease, not the same line twice', async ({
    page,
  }) => {
    await boot(page, { track: DEFAULT.id });
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('close'));
    await frames(page, 3);
    await shot(page, 'cel-closeup', 'flat cel bands, an ink silhouette, and interior creases');

    const a = await page.evaluate(() => window.sparkdrift!.analyseEdges());

    expect(a.outlineOnly.ink, 'the inverted hull drew no outline').toBeGreaterThan(200);
    expect(a.sobelOnly.ink, 'the Sobel pass drew no edges').toBeGreaterThan(200);

    // The decisive assertion: the Sobel draws ink the hull does not cover
    // anywhere within two pixels. A hull only ever produces a silhouette, so
    // lines it never covers are interior lines — creases it cannot draw.
    expect(
      a.sobelOnly.unique,
      'the Sobel found no lines the hull was not already drawing — the two systems are drawing the same line twice',
    ).toBeGreaterThan(500);
    expect(a.outlineOnly.unique).toBeGreaterThan(100);
    expect(a.both.ink).toBeGreaterThan(a.outlineOnly.ink);
    expect(a.both.ink).toBeGreaterThan(a.sobelOnly.ink);

    console.log(
      `  edges: hull ${a.outlineOnly.ink}px (${a.outlineOnly.unique} unique), ` +
        `sobel ${a.sobelOnly.ink}px (${a.sobelOnly.unique} unique), both ${a.both.ink}px`,
    );
  });

  test('the grid, a drift, and the jump', async ({ page }) => {
    await boot(page, { track: DEFAULT.id });
    await frames(page, 3);
    await shot(page, 'grid', 'eight karts on the grid, all sitting on the road surface');

    const s0 = await stats(page);
    for (const k of s0.karts) {
      expect(k.onRoad, `kart ${k.index} (${k.driverId}) is not on the road at the start`).toBe(true);
      expect(k.wheelsOnGround, `kart ${k.index} has wheels off the ground on the grid`).toBe(4);
    }

    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
    await teleport(page, 0, 0.3 * DEFAULT.lap, -2, 20);
    await setControls(page, 0, { throttle: 1, steer: 0.85, drift: true });
    // Tier 1 needs 0.55 s of genuine sliding. Much past a second of full lock
    // on a straight and the kart has scrubbed below the drift cancel speed, so
    // the shot catches the drift already over.
    await simulate(page, 1.15);
    const drift = await stats(page);
    expect(drift.karts[0]!.drifting, 'the kart is not drifting').toBe(true);
    expect(drift.karts[0]!.driftTier, 'the drift charged no tier').toBeGreaterThanOrEqual(1);
    await page.evaluate(() => window.sparkdrift!.setCameraPreset('chase'));
    await frames(page, 4);
    await shot(
      page,
      'drift',
      `a committed drift charged to tier ${drift.karts[0]!.driftTier}, with tier-coloured sparks`,
    );
    await setControls(page, 0, null);
  });

  test('the jump on Snowline Pass actually leaves the ground', async ({ page }) => {
    const snow = TRACKS.find((t) => t.id === 'snowline-pass')!;
    await boot(page, { track: snow.id });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
    // The validator puts take-off at u=184 m; approach from well before it.
    await setControls(page, 0, { throttle: 1, steer: 0 });
    await teleport(page, 0, 150, 0, 24.5);
    await simulate(page, 1.5);
    const air = await stats(page);
    await frames(page, 3);
    await shot(page, 'jump', 'the kart leaves the ramp and its shadow separates from it');
    expect(
      air.karts[0]!.airborne || air.karts[0]!.airtime > 0,
      'the kart never got airborne over the ramp',
    ).toBeTruthy();
    await setControls(page, 0, null);
  });

  test('scenery instances are spread, not stacked at the origin', async ({ page }) => {
    await boot(page);
    const s = await stats(page);
    // A count assertion passes for a hundred objects in one invisible pile, so
    // this asserts the *spread* of the instance set.
    expect(s.scenerySpread).not.toBeNull();
    expect(s.scenerySpread!.count).toBeGreaterThan(50);
    expect(
      s.scenerySpread!.sizeX,
      'scenery instances are not spread in X — instanceMatrix is probably not applied',
    ).toBeGreaterThan(100);
    expect(s.scenerySpread!.sizeZ).toBeGreaterThan(100);
  });
});
