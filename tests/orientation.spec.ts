import { expect, test } from '@playwright/test';
import { boot, frames, overlaps, shot, simulate, stats } from './helpers.ts';

/**
 * Landscape gate, and the leaderboard's racing visibility.
 *
 * Both of these are claims about what is on the screen, so both are asserted
 * against measured rectangles and a measured simulation clock rather than
 * against a screenshot anyone has to squint at. The screenshots exist so a
 * reviewer can see the thing; the assertions are what fail.
 */

const PHONE_PORTRAIT = { width: 390, height: 844 };
const PHONE_LANDSCAPE = { width: 844, height: 390 };

test.describe('landscape gate', () => {
  test('portrait covers the screen and freezes the simulation', async ({ page }) => {
    await page.setViewportSize(PHONE_PORTRAIT);
    await boot(page, { gate: true, touch: true, track: 'kayal-causeway' });

    const gate = page.locator('.sd-rotate');
    await expect(gate).toBeVisible();
    await expect(gate).toContainText(/turn your phone/i);

    // The gate covers everything. Anything less and a stray tap reaches a
    // control the player cannot see.
    const box = (await gate.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(PHONE_PORTRAIT.width - 1);
    expect(box.height).toBeGreaterThanOrEqual(PHONE_PORTRAIT.height - 1);

    // Frozen, not merely hidden: the race clock must not move behind it.
    const before = await stats(page);
    expect(before.paused).toBe(true);
    await simulate(page, 3);
    const after = await stats(page);
    expect(after.time).toBeCloseTo(before.time, 5);
    expect(after.karts[0]!.progress).toBeCloseTo(before.karts[0]!.progress, 3);

    await shot(page, 'gate-portrait', 'portrait shows the rotate prompt and nothing else');
  });

  test('landscape lets the race run', async ({ page }) => {
    await page.setViewportSize(PHONE_LANDSCAPE);
    await boot(page, { gate: true, touch: true, track: 'kayal-causeway' });

    await expect(page.locator('.sd-rotate')).toBeHidden();
    const before = await stats(page);
    expect(before.paused).toBe(false);
    await simulate(page, 2);
    const after = await stats(page);
    expect(after.time).toBeGreaterThan(before.time + 1.5);

    await shot(page, 'gate-landscape', 'the same phone in landscape races with no gate');
  });

  test('rotating mid-race pauses and resumes in place', async ({ page }) => {
    await page.setViewportSize(PHONE_LANDSCAPE);
    await boot(page, { gate: true, touch: true, track: 'kayal-causeway' });
    await simulate(page, 6);

    const racing = await stats(page);
    expect(racing.paused).toBe(false);

    await page.setViewportSize(PHONE_PORTRAIT);
    await frames(page, 3);
    await expect(page.locator('.sd-rotate')).toBeVisible();
    const gated = await stats(page);
    expect(gated.paused).toBe(true);
    // The race is the same race — it kept its clock and its distance rather
    // than restarting — and it is genuinely stopped, not merely covered.
    expect(gated.time - racing.time).toBeLessThan(0.25);
    expect(gated.karts[0]!.lap).toBe(racing.karts[0]!.lap);
    await simulate(page, 3);
    expect((await stats(page)).karts[0]!.progress).toBeCloseTo(gated.karts[0]!.progress, 3);

    await page.setViewportSize(PHONE_LANDSCAPE);
    await frames(page, 3);
    await expect(page.locator('.sd-rotate')).toBeHidden();
    const resumed = await stats(page);
    expect(resumed.paused).toBe(false);
    // It picks up from where it stopped. The live loop is running again by the
    // time this reads, so a few frames of genuine racing have happened — what
    // must NOT have happened is the wall-clock spent behind the gate being
    // banked in the accumulator and dumped in at once. A quarter of a second is
    // the whole budget: three frames plus the loop's 8-step clamp.
    expect(resumed.time - racing.time).toBeLessThan(0.25);
    expect(resumed.time).toBeGreaterThanOrEqual(racing.time);

    await simulate(page, 2);
    expect((await stats(page)).karts[0]!.progress).toBeGreaterThan(racing.karts[0]!.progress);
  });

  test('a landscape window too short to play is gated as well', async ({ page }) => {
    // A phone in landscape with the browser chrome and a keyboard open, or a
    // desktop window dragged flat. Wider than it is tall, and still unplayable.
    await page.setViewportSize({ width: 900, height: 260 });
    await boot(page, { gate: true, touch: true });
    await expect(page.locator('.sd-rotate')).toBeVisible();
    expect((await stats(page)).paused).toBe(true);
  });
});

test.describe('leaderboard visibility', () => {
  test('desktop: on the grid, gone while racing, back at the flag', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page, { track: 'kayal-causeway', karts: 8 });

    // On the grid, during the countdown, the running order is worth the space.
    const grid = await stats(page);
    expect(grid.phase).toBe('countdown');
    expect(grid.uiRects['hud.board']).toBeTruthy();

    // Five seconds in — past the countdown and past the 1.5 s grace — it is
    // gone, and it has taken its rows with it. Eight rows of names in the
    // corner is space spent on what the big position number top-left already
    // says, for the whole race.
    await simulate(page, 5);
    // The HUD is written during render, not during the fixed step, so its
    // state is only current after a real frame has run.
    await frames(page, 2);
    const racing = await stats(page);
    expect(racing.phase).toBe('racing');
    expect(racing.uiRects['hud.board']).toBeUndefined();
    expect(racing.uiRects['hud.board.row0']).toBeUndefined();

    // The flag brings it back: this is the moment the order is the story.
    await page.evaluate(() => window.sparkdrift!.setPhase('finished'));
    await frames(page, 3);
    const flag = await stats(page);
    expect(flag.uiRects['hud.board']).toBeTruthy();
    expect(flag.uiRects['hud.board.row0']).toBeTruthy();
  });

  test('phone landscape: the countdown owns the centre, the board waits', async ({ page }) => {
    await page.setViewportSize(PHONE_LANDSCAPE);
    await boot(page, { touch: true, track: 'kayal-causeway', karts: 8 });

    // 390 px of height cannot carry both. The numeral wins.
    const grid = await stats(page);
    expect(grid.phase).toBe('countdown');
    expect(grid.uiRects['hud.board']).toBeUndefined();

    await simulate(page, 5);
    await frames(page, 2);
    const racing = await stats(page);
    expect(racing.phase).toBe('racing');
    expect(racing.uiRects['hud.board']).toBeUndefined();
    await shot(page, 'board-hidden-racing', 'no leaderboard on screen while the race is running');

    await page.evaluate(() => window.sparkdrift!.setPhase('finished'));
    await frames(page, 3);
    expect((await stats(page)).uiRects['hud.board']).toBeTruthy();
  });

  test('phone landscape: nothing on the HUD sits under anything else', async ({ page }) => {
    await page.setViewportSize(PHONE_LANDSCAPE);
    await boot(page, { touch: true, track: 'kayal-causeway', karts: 8 });

    // Both moments, because they have different things on screen: the grid
    // shows the countdown numeral, the race shows the full control set.
    for (const moment of ['grid', 'racing'] as const) {
      if (moment === 'racing') {
        await simulate(page, 5);
        await frames(page, 2);
      }
      const s = await stats(page);
      // The instruments the player steers by must all be present and drawn.
      for (const key of ['hud.position', 'hud.lap', 'hud.speed', 'hud.minimap']) {
        expect(s.uiRects[key], `${key} missing at ${moment}`).toBeTruthy();
      }
      const entries = Object.entries(s.uiRects);
      const collisions: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [an, a] = entries[i]!;
          const [bn, b] = entries[j]!;
          // The steering zone deliberately sits under the item slot's column
          // on the desktop layout only; here nothing is allowed to share.
          if (overlaps(a, b)) collisions.push(`${an} × ${bn}`);
        }
      }
      expect(collisions, `overlapping HUD boxes at ${moment}`).toEqual([]);
    }
  });
});
