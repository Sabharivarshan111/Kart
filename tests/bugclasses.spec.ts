import { expect, test } from '@playwright/test';
import { boot, overlaps, setControls, simulate, stats, teleport } from './helpers.ts';

/**
 * One test per kart-specific bug class from the brief's section 3.
 *
 * These are the bugs that look completely fine in code and are wrong on screen
 * (or wrong three laps later). Each test below states the class it covers and
 * asserts against a measurement, never against a screenshot.
 */

// Lap length of the default track (Kayal Causeway), as measured by the geometry
// validator. Kept as one constant because every placement below is a fraction
// of it — when this drifts out of date the tests quietly start measuring a
// different part of the circuit than they were written for.
const LAP_COPPER = 780;

test.describe('bug classes', () => {
  // -------------------------------------------------------------------------
  test('1 — tunnelling: full speed into every wall type leaves the kart on the track', async ({
    page,
  }) => {
    await boot(page, { karts: 1 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));

    // Sixteen points around the lap, so barriers on straights, on corners, on
    // the banked section and through the widened landing zone are all hit.
    for (let i = 0; i < 16; i++) {
      const u = (i / 16) * LAP_COPPER;
      for (const side of [-1, 1]) {
        // Aimed square at the barrier at boosted top speed, which is the
        // fastest a kart can ever arrive at one.
        await teleport(page, 0, u, side * 2, 33, undefined);
        await setControls(page, 0, { throttle: 1, steer: side });
        await simulate(page, 1.2);
        const s = await stats(page);
        const k = s.karts[0]!;
        expect(
          k.surface,
          `kart went through the barrier at u=${u.toFixed(0)} on side ${side} ` +
            `(lateral ${k.lateral.toFixed(2)}, surface ${k.surface})`,
        ).not.toBe(5 /* SurfaceKind.Void */);
        // Still inside the corridor, not beyond the wall line.
        expect(Math.abs(k.lateral), `kart is ${k.lateral.toFixed(2)} m off the centreline`).toBeLessThan(12);
      }
    }
    await setControls(page, 0, null);
  });

  // -------------------------------------------------------------------------
  test('2 — sticky walls: leaning harder on the barrier does not slow the kart more', async ({
    page,
  }) => {
    await boot(page, { karts: 1 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));

    // Reaching the barrier means crossing the verge, and on this track the
    // verge is grass, which costs most of the speed all by itself. An absolute
    // "keeps 70% of its speed" bar would therefore be measuring grass drag and
    // calling it wall behaviour.
    //
    // What isolates the wall is the *gradient*: a sticky wall cancels the
    // velocity component pushed into it, so the harder you steer into the
    // barrier the more speed you lose, and at full lock you stop dead. A
    // correct response reflects the tangential component instead, so leaning on
    // it costs nothing extra — the kart just slides along.
    const run = async (steer: number) => {
      await teleport(page, 0, 0.30 * LAP_COPPER, 5.0, 22);
      await setControls(page, 0, { throttle: 1, steer });
      await simulate(page, 1.5);
      return (await stats(page)).karts[0]!;
    };

    const light = await run(0.16);
    const hard = await run(0.6);

    // Both runs must actually be against the barrier, or this proves nothing.
    expect(light.distanceToEdge, 'the light run never left the road').toBeLessThan(0);
    expect(hard.distanceToEdge, 'the hard run never left the road').toBeLessThan(0);
    expect(
      Math.abs(hard.lateral - light.lateral),
      'the two runs ended at different lateral offsets, so they are not both on the wall',
    ).toBeLessThan(0.2);

    // The gradient assertion. Anything below 0.9 means pressing into the wall
    // is being punished, which is the pinning behaviour this class is about.
    const ratio = hard.speed / Math.max(0.001, light.speed);
    expect(
      ratio,
      `leaning on the barrier cost ${((1 - ratio) * 100).toFixed(0)}% more speed than brushing it ` +
        `(hard ${hard.speed.toFixed(1)} m/s vs light ${light.speed.toFixed(1)} m/s) — the wall is sticky`,
    ).toBeGreaterThan(0.9);

    // And it is still travelling, not pinned to the barrier.
    expect(hard.speed, 'the kart is stuck on the wall').toBeGreaterThan(6);
    await setControls(page, 0, null);
  });

  // -------------------------------------------------------------------------
  test('3 — drift charging: holding the button while stationary charges nothing', async ({
    page,
  }) => {
    await boot(page, { karts: 1 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));

    // On the grid, stationary, drift and steer held for three seconds — long
    // enough for all three tiers if charge came from the button.
    await teleport(page, 0, 0.5 * LAP_COPPER, 0, 0);
    await setControls(page, 0, { throttle: 0, steer: 1, drift: true });
    await simulate(page, 3.0);
    const still = (await stats(page)).karts[0]!;
    expect(still.driftCharge, 'the drift charged while stationary').toBe(0);
    expect(still.driftTier, 'a tier was reached while stationary').toBe(0);
    expect(still.drifting, 'a drift started below the minimum speed').toBe(false);

    // Rolling slowly but below the drift minimum: also nothing.
    await teleport(page, 0, 0.5 * LAP_COPPER, 0, 5);
    await setControls(page, 0, { throttle: 0.2, steer: 1, drift: true });
    await simulate(page, 2.0);
    expect((await stats(page)).karts[0]!.driftTier).toBe(0);

    // And the positive control: at speed, genuinely sliding, it does charge.
    await teleport(page, 0, 0.33 * LAP_COPPER, -2, 21);
    await setControls(page, 0, { throttle: 1, steer: 0.9, drift: true });
    await simulate(page, 1.5);
    const sliding = (await stats(page)).karts[0]!;
    expect(sliding.driftCharge, 'a real slide charged nothing').toBeGreaterThan(0);
    expect(Math.abs(sliding.slip), 'the kart was not actually sliding').toBeGreaterThan(1);
    await setControls(page, 0, null);
  });

  // -------------------------------------------------------------------------
  test('4 — lap counting: reversing over the line ten times counts no laps', async ({ page }) => {
    await boot(page, { karts: 1 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));

    const startLap = (await stats(page)).karts[0]!.lap;

    for (let i = 0; i < 10; i++) {
      // Just before the line, moving forward over it...
      await teleport(page, 0, LAP_COPPER - 6, 0, 10);
      await setControls(page, 0, { throttle: 1 });
      await simulate(page, 1.0);
      // ...then back behind it again, facing backwards.
      await teleport(page, 0, 6, 0, 10, Math.PI);
      await setControls(page, 0, { throttle: 1 });
      await simulate(page, 1.0);
    }

    const after = (await stats(page)).karts[0]!;
    // Crossing the line forward ten times *does* legitimately trip checkpoint
    // zero, but a lap needs every checkpoint in order, and the kart never
    // visited any of the others. At most one lap can be credited.
    expect(
      after.lap - startLap,
      `reversing over the line ten times credited ${after.lap - startLap} laps`,
    ).toBeLessThanOrEqual(1);
    await setControls(page, 0, null);
  });

  // -------------------------------------------------------------------------
  test('5 — respawn: recovery always faces along the track tangent', async ({ page }) => {
    await boot(page, { karts: 1 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));

    // Twenty pseudo-random off-track positions, spread around the lap and on
    // both sides, each spinning when recovery triggers.
    for (let i = 0; i < 20; i++) {
      const u = ((i * 37.4) % 100) / 100 * LAP_COPPER;
      const side = i % 2 === 0 ? -1 : 1;
      // Well outside the corridor, facing a deliberately wrong way.
      await teleport(page, 0, u, side * 30, 6, (i * 1.31) % (Math.PI * 2));
      await setControls(page, 0, { throttle: 0 });
      // Long enough for the off-track grace period to elapse.
      await simulate(page, 2.6);

      const k = (await stats(page)).karts[0]!;
      expect(k.respawns, `no respawn happened from off-track position ${i}`).toBeGreaterThan(0);

      // Drive forward briefly: if the heading agrees with the tangent, progress
      // increases. Facing backwards it would decrease. This checks the thing
      // that actually matters rather than an angle in isolation.
      const before = (await stats(page)).karts[0]!.u;
      await setControls(page, 0, { throttle: 1 });
      await simulate(page, 0.8);
      const afterK = (await stats(page)).karts[0]!;
      let delta = afterK.u - before;
      if (delta < -LAP_COPPER / 2) delta += LAP_COPPER;
      if (delta > LAP_COPPER / 2) delta -= LAP_COPPER;
      expect(
        delta,
        `respawn ${i} at u=${u.toFixed(0)} faced the wrong way: driving forward moved ${delta.toFixed(1)} m along the track`,
      ).toBeGreaterThan(0);
      expect(afterK.onRoad, `respawn ${i} did not put the kart on the road`).toBe(true);
    }
    await setControls(page, 0, null);
  });

  // -------------------------------------------------------------------------
  test('6 — AI obeys the same collision: a full AI-only race stays on the road', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await boot(page, { karts: 8, difficulty: 0.8 });
    await page.evaluate(() => {
      window.sparkdrift!.setPlayerAi(true);
      window.sparkdrift!.setPhase('racing');
    });

    // Sampled every 0.25 s across 90 s of racing. Sampling is what catches a
    // kart that is off-road *transiently* — a check only at the end would miss
    // every excursion that recovered.
    const worstOffTrack = new Array(8).fill(0);
    // `offTrackTimer` only counts time on **Void** — fully outside the corridor.
    // A kart pinned against the barrier on the verge is on-road=false the whole
    // time and never accumulates a single tick of it. That is exactly how this
    // test passed for a whole session while the AI could not complete a lap, so
    // the sample now records what fraction of the race each kart spent with
    // wheels off the *road*, which is the thing the class is actually about.
    const offRoadSamples = new Array(8).fill(0);
    let samples = 0;
    let maxRespawns = 0;
    for (let i = 0; i < 360; i++) {
      await simulate(page, 0.25);
      const s = await stats(page);
      samples++;
      for (const k of s.karts) {
        worstOffTrack[k.index] = Math.max(worstOffTrack[k.index], k.offTrackTimer);
        if (!k.onRoad) offRoadSamples[k.index]++;
        maxRespawns = Math.max(maxRespawns, k.respawns);
      }
    }

    for (let i = 0; i < worstOffTrack.length; i++) {
      expect(
        worstOffTrack[i],
        `AI kart ${i} was off the corridor for ${worstOffTrack[i].toFixed(2)} s`,
      ).toBeLessThan(1.0);
    }

    // Off the road for most of the race is the failure this class exists to
    // catch, and a corridor-only timer cannot see it.
    for (let i = 0; i < offRoadSamples.length; i++) {
      const fraction = offRoadSamples[i] / Math.max(1, samples);
      expect(
        fraction,
        `AI kart ${i} spent ${(fraction * 100).toFixed(0)}% of the race off the road`,
      ).toBeLessThan(0.25);
    }

    // And they actually raced. 200 m over 90 s is 2.2 m/s against a 24.5 m/s
    // top speed — a bar that low passes for a kart grinding along a barrier,
    // which is what it was doing. A competent lap is well over 1200 m.
    const s = await stats(page);
    for (const k of s.karts) {
      expect(
        k.progress,
        `AI kart ${k.index} covered only ${k.progress.toFixed(0)} m in 90 s`,
      ).toBeGreaterThan(1000);
    }
    // eslint-disable-next-line no-console
    console.log(
      `  AI-only race: worst off-track ${Math.max(...worstOffTrack).toFixed(2)} s, ` +
        `max respawns ${maxRespawns}, leader progress ${Math.max(...s.karts.map((k) => k.progress)).toFixed(0)} m`,
    );
  });

  // -------------------------------------------------------------------------
  test('7 — instancing: the scenery set is spread, not stacked at the origin', async ({ page }) => {
    await boot(page);
    const s = await stats(page);
    expect(s.scenerySpread).not.toBeNull();
    // A count assertion passes for a hundred objects in one invisible pile, so
    // the assertion is on the extent.
    expect(s.scenerySpread!.count).toBeGreaterThan(50);
    expect(s.scenerySpread!.sizeX).toBeGreaterThan(100);
    expect(s.scenerySpread!.sizeZ).toBeGreaterThan(100);
    // A single instance is about 3.5 m tall and 1.5 m wide. If instanceMatrix
    // were being ignored the whole set would measure roughly one instance.
    expect(s.scenerySpread!.sizeX).toBeGreaterThan(20 * 1.5);
  });

  // -------------------------------------------------------------------------
  test('8 — palettes do not collapse to black at each track’s own sun angle', async ({
    page,
  }) => {
    await boot(page);
    const reports = await page.evaluate(() => window.sparkdrift!.validateAllTracks());
    for (const r of reports) {
      const collapses = r.issues.filter((i) => i.kind === 'palette-collapses');
      expect(
        collapses.map((c) => c.message),
        `theme for ${r.trackId} collapses under its own sun`,
      ).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  test('9 — leaderboard text is clipped to its row, badge or no badge', async ({ page }) => {
    await boot(page, { karts: 8 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
    // Give the leader a boost so their row carries a badge and therefore has
    // less room for the name than every other row.
    await setControls(page, 0, { throttle: 1 });
    await simulate(page, 4);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );

    const s = await stats(page);
    const row = s.uiRects['hud.board.row0'];
    const name = s.uiRects['hud.board.row0.name'];
    const badge = s.uiRects['hud.board.row0.badge'];
    expect(row).toBeTruthy();
    expect(name).toBeTruthy();

    // The name box must sit inside its row, with a pixel of tolerance for
    // sub-pixel layout rounding.
    expect(name!.x + name!.w, 'the leaderboard name overflows its row').toBeLessThanOrEqual(
      row!.x + row!.w + 1,
    );
    if (badge) {
      expect(overlaps(name!, badge!), 'the name and the badge overlap').toBe(false);
    }
    await setControls(page, 0, null);
  });

  // -------------------------------------------------------------------------
  test('10 — the tap gate measures distance, not duration', async ({ page }) => {
    await boot(page, { touch: true });

    const box = await page.locator('.sd-steer').boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    const before = (await page.evaluate(() => window.sparkdrift!.touchState())).taps;

    // A *slow* tap: held for 700 ms, far beyond any plausible duration limit,
    // but never moved. A duration-based gate rejects this — and rejects genuine
    // taps on a loaded phone, where two handler invocations are routinely
    // 250 ms apart because a whole render frame sits between them.
    await page.evaluate(
      async ([x, y]) => {
        const zone = document.querySelector('.sd-steer') as HTMLElement;
        zone.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 11, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true,
          }),
        );
        await new Promise((r) => setTimeout(r, 700));
        zone.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 11, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true,
          }),
        );
      },
      [cx, cy] as const,
    );

    const afterTap = (await page.evaluate(() => window.sparkdrift!.touchState())).taps;
    expect(
      afterTap - before,
      'a 700 ms stationary press was not recognised as a tap — the gate is measuring duration',
    ).toBe(1);

    // And the negative control: a *fast* drag must not count as a tap, however
    // brief it was.
    await page.evaluate(
      async ([x, y]) => {
        const zone = document.querySelector('.sd-steer') as HTMLElement;
        zone.dispatchEvent(
          new PointerEvent('pointerdown', {
            pointerId: 12, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true,
          }),
        );
        for (let i = 1; i <= 6; i++) {
          zone.dispatchEvent(
            new PointerEvent('pointermove', {
              pointerId: 12, clientX: x + i * 10, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true,
            }),
          );
        }
        zone.dispatchEvent(
          new PointerEvent('pointerup', {
            pointerId: 12, clientX: x + 60, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: true,
          }),
        );
      },
      [cx, cy] as const,
    );

    const afterDrag = (await page.evaluate(() => window.sparkdrift!.touchState())).taps;
    expect(afterDrag - afterTap, 'a 60 px drag was counted as a tap').toBe(0);
  });

  // -------------------------------------------------------------------------
  test('11 — every track passes the geometry validator, jumps included', async ({ page }) => {
    await boot(page);
    const reports = await page.evaluate(() => window.sparkdrift!.validateAllTracks());
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      const errors = r.issues.filter((i) => i.severity === 'error');
      expect(errors.map((e) => `${e.kind}: ${e.message}`), `${r.trackId} failed validation`).toEqual(
        [],
      );
      expect(r.ok, `${r.trackId} did not pass`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  test('12 — reduce camera motion actually reduces roll and FOV kick', async ({ page }) => {
    await boot(page, { karts: 1 });
    await page.evaluate(() => window.sparkdrift!.setPhase('racing'));

    // The banked section of Copper Flats, taken at speed, is where roll is
    // largest.
    const measure = async (reduced: boolean) => {
      await page.evaluate((r) => window.sparkdrift!.setReducedMotion(r), reduced);
      await teleport(page, 0, 0.34 * LAP_COPPER, 2, 20);
      await setControls(page, 0, { throttle: 1, steer: 0.3 });
      let worstRoll = 0;
      let worstFov = 0;
      for (let i = 0; i < 40; i++) {
        await simulate(page, 0.05);
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
        const s = await stats(page);
        worstRoll = Math.max(worstRoll, Math.abs(s.cameraRoll));
        worstFov = Math.max(worstFov, s.cameraFov);
      }
      return { worstRoll, worstFov };
    };

    const normal = await measure(false);
    const reduced = await measure(true);

    expect(
      reduced.worstRoll,
      `reduce-motion did not reduce roll (${reduced.worstRoll.toFixed(4)} vs ${normal.worstRoll.toFixed(4)})`,
    ).toBeLessThan(normal.worstRoll);
    expect(reduced.worstFov).toBeLessThanOrEqual(normal.worstFov);
    // And normal roll is itself only a fraction of the track's bank, which is
    // 13° here — a camera that matched the bank would be 0.227 rad.
    expect(normal.worstRoll).toBeLessThan(0.227 * 0.6);

    await setControls(page, 0, null);
    await page.evaluate(() => window.sparkdrift!.setReducedMotion(false));
  });
});
