import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared harness plumbing.
 *
 * Every named shot carries a note saying **what it proves**. A screenshot with
 * no claim attached is decoration; the point of the list is that each frame is
 * evidence for one specific statement.
 */

export const SHOT_DIR = 'shots';

export interface BootOptions {
  track?: string;
  seed?: number;
  karts?: number;
  difficulty?: number;
  touch?: boolean;
  mode?: 'grand-prix' | 'time-trial' | 'arena';
}

export async function boot(page: Page, opts: BootOptions = {}): Promise<void> {
  const params = new URLSearchParams();
  params.set('seed', String(opts.seed ?? 1));
  // Straight into a race, past the title screen. The shell is exercised by its
  // own shots rather than by every test in the suite having to navigate it.
  params.set('race', '1');
  if (opts.track) params.set('track', opts.track);
  if (opts.karts !== undefined) params.set('karts', String(opts.karts));
  if (opts.difficulty !== undefined) params.set('difficulty', String(opts.difficulty));
  if (opts.touch) params.set('touch', '1');
  if (opts.mode) params.set('mode', opts.mode);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`/?${params.toString()}`);
  await page.waitForFunction(() => !!window.sparkdrift, undefined, { timeout: 30_000 });
  await page.evaluate(() => window.sparkdrift!.ready);

  // A page error during boot means every later assertion is measuring a broken
  // build, so it fails here rather than producing a confusing downstream result.
  expect(errors, `page errors during boot: ${errors.join(' | ')}`).toEqual([]);
}

export async function stats(page: Page) {
  return page.evaluate(() => window.sparkdrift!.stats());
}

export async function simulate(page: Page, seconds: number, dt?: number): Promise<void> {
  await page.evaluate(
    ([s, d]) => window.sparkdrift!.simulate(s as number, d as number | undefined),
    [seconds, dt] as const,
  );
}

export async function setControls(
  page: Page,
  index: number,
  controls: Record<string, unknown> | null,
): Promise<void> {
  await page.evaluate(
    ([i, c]) => window.sparkdrift!.setControls(i as number, c as never),
    [index, controls] as const,
  );
}

export async function teleport(
  page: Page,
  index: number,
  u: number,
  lateral: number,
  speed = 0,
  heading?: number,
): Promise<void> {
  await page.evaluate(
    ([i, uu, l, s, h]) =>
      window.sparkdrift!.teleport(
        i as number,
        uu as number,
        l as number,
        s as number,
        h as number | undefined,
      ),
    [index, u, lateral, speed, heading] as const,
  );
}

/**
 * Capture a named shot. `proves` is not decoration: it is written into the
 * filename's sidecar in the test output so a reviewer can see the claim next to
 * the evidence.
 */
export async function shot(page: Page, name: string, proves: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  // Two frames so the capture lands on a fully presented frame rather than
  // mid-composite.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`  shot ${name}.png — proves: ${proves}`);
}

/** Axis-aligned rectangle overlap, for the geometric UI assertions. */
export function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Advance real animation frames (not the fixed-step harness), for anything
 *  that depends on rendering having actually happened. */
export async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }, n);
}
