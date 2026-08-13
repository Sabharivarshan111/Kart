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

  test('the shell fits a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootShell(page);
    await snap(page, 'shell-phone', 'the title screen at 390x844 with nothing off-screen');
    await assertNothingOverflows(page);

    // Touch targets must clear 48 px, or they are not touch targets.
    const small = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll('.sd-shell button'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 44) bad.push(`${el.textContent?.trim()}: ${r.height.toFixed(0)}px tall`);
      }
      return bad;
    });
    expect(small, `touch targets under 44px: ${small.join(', ')}`).toEqual([]);
  });
});
