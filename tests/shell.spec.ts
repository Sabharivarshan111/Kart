import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SHOT_DIR } from './helpers.ts';

/**
 * The shell: title, mode select, cup select, character select, options and the
 * licences screen.
 *
 * These boot **without** `race=1`, which is the only place in the suite that
 * does — everything else goes straight to a corner. So this file is the only
 * evidence that the menus exist at all, and it is deliberately the only file
 * that has to be updated when navigation changes.
 */

async function bootShell(page: import('@playwright/test').Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?seed=1');
  await page.waitForFunction(() => !!window.sparkdrift, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.sparkdrift!.ready);
  await page.waitForSelector('.sd-shell', { timeout: 10_000 });
  expect(errors, `page errors during boot: ${errors.join(' | ')}`).toEqual([]);
}

async function snap(page: import('@playwright/test').Page, name: string, proves: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`  shot ${name}.png — proves: ${proves}`);
}

/** Every visible, interactive control must fit the viewport. A menu item half
 *  off the bottom of a phone is unreachable, and unreachable is the same as
 *  absent. */
async function assertNothingOverflows(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.sd-shell button, .sd-shell [role="button"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        bad.push(`${el.className || el.tagName} at ${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
      }
    }
    return bad;
  });
  expect(overflow, `controls outside the viewport: ${overflow.join(' | ')}`).toEqual([]);
}

test.describe('shell', () => {
  test('the title screen comes up over a live race backdrop', async ({ page }) => {
    await bootShell(page);
    await snap(page, 'shell-title', 'the title screen, over an AI race running as the backdrop');
    await assertNothingOverflows(page);

    // The backdrop is a real race, not a still. If the AI were not driving, the
    // menu would be sitting over a parked grid.
    await page.evaluate(() => window.sparkdrift!.simulate(2));
    const s = await page.evaluate(() => window.sparkdrift!.stats());
    expect(
      Math.max(...s.karts.map((k) => k.speed)),
      'nothing is moving behind the title screen',
    ).toBeGreaterThan(4);
  });

  test('the licences screen is reachable from inside the game', async ({ page }) => {
    // This is a binding obligation, not a nice-to-have: Three.js is MIT and its
    // notice has to ship *and* be reachable. Writing the text is the easy half.
    await bootShell(page);

    const opened = await page.evaluate(async () => {
      const click = (pred: (t: string) => boolean): boolean => {
        const buttons = Array.from(
          document.querySelectorAll('.sd-shell button'),
        ) as HTMLElement[];
        const hit = buttons.find((b) => pred((b.textContent ?? '').toLowerCase()));
        if (!hit) return false;
        hit.click();
        return true;
      };
      const wait = () => new Promise((r) => setTimeout(r, 120));

      if (!click((t) => t.includes('option') || t.includes('setting'))) return 'no options button';
      await wait();
      if (!click((t) => t.includes('licence') || t.includes('license'))) return 'no licences button';
      await wait();
      return 'ok';
    });
    expect(opened, 'could not navigate to the licences screen').toBe('ok');

    await snap(page, 'shell-licences', 'the open-source licences screen, reached from the menus');

    const text = await page.evaluate(() => document.querySelector('.sd-shell')?.textContent ?? '');
    // The full MIT text, not a link — there is no network guarantee.
    expect(text, 'the MIT permission notice is missing').toContain('Permission is hereby granted');
    expect(text, 'the warranty disclaimer is missing').toContain('WITHOUT WARRANTY');
    expect(text.toLowerCase(), 'Three.js is not credited').toContain('three');
  });

  test('cup and character select show real content', async ({ page }) => {
    await bootShell(page);

    const reached = await page.evaluate(async () => {
      const click = (pred: (t: string) => boolean): boolean => {
        const buttons = Array.from(document.querySelectorAll('.sd-shell button')) as HTMLElement[];
        const hit = buttons.find((b) => pred((b.textContent ?? '').toLowerCase()));
        if (!hit) return false;
        hit.click();
        return true;
      };
      const wait = () => new Promise((r) => setTimeout(r, 120));
      if (!click((t) => t.includes('grand prix') || t.includes('start') || t.includes('race'))) {
        return 'no start button';
      }
      await wait();
      return 'ok';
    });
    expect(reached).toBe('ok');
    await snap(page, 'shell-select', 'mode or cup select, showing the two cups and their tracks');
    await assertNothingOverflows(page);
  });

  // The phone case is **landscape**, because portrait is gated (see
  // src/ui/orientation.ts) and a screen the player is never shown is not worth
  // asserting on. This test existed at 390x844 and passed, which is exactly why
  // the title screen's START button being 18 px below the fold at 844x390 went
  // unnoticed: the suite was measuring the one shape the game refuses to run in.
  for (const size of [
    { name: 'phone-landscape', width: 844, height: 390 },
    { name: 'phone-landscape-small', width: 740, height: 340 },
  ]) {
    test(`every menu fits ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await bootShell(page);
      await assertNothingOverflows(page);
      if (size.name === 'phone-landscape') {
        await snap(page, 'shell-phone', `the title screen at ${size.width}x${size.height}`);
      }

      // Touch targets must clear 48 px, or they are not touch targets. This is
      // the one thing the short-viewport layout may not trade away.
      const tooSmall = async () =>
        page.evaluate(() => {
          const bad: string[] = [];
          for (const el of Array.from(document.querySelectorAll('.sd-shell button'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.height < 44) bad.push(`${el.textContent?.trim()}: ${r.height.toFixed(0)}px tall`);
          }
          return bad;
        });
      expect(await tooSmall()).toEqual([]);

      // Walk the whole shell, not just the first screen: every one of these was
      // laid out as a tall column and every one of them has to survive being
      // 390 px high.
      const steps = [
        { label: 'mode select', needle: 'start' },
        { label: 'cup select', needle: 'grand prix' },
        { label: 'track or driver select', needle: 'cup' },
      ];
      for (const step of steps) {
        const clicked = await page.evaluate((needle) => {
          const buttons = Array.from(document.querySelectorAll('.sd-shell button')) as HTMLElement[];
          const hit = buttons.find((b) => (b.textContent ?? '').toLowerCase().includes(needle));
          if (!hit) return false;
          hit.click();
          return true;
        }, step.needle);
        if (!clicked) break;
        await page.waitForTimeout(150);
        await assertNothingOverflows(page);
        expect(await tooSmall(), `small targets on ${step.label}`).toEqual([]);
      }

      // Options and licences, which are the longest reading screens in the app.
      await page.evaluate(() => {
        const back = Array.from(document.querySelectorAll('.sd-shell button')).find((b) =>
          /back|esc/i.test(b.textContent ?? ''),
        ) as HTMLElement | undefined;
        back?.click();
      });
      await page.waitForTimeout(150);
      await assertNothingOverflows(page);
    });
  }
});
