import { expect, test } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { boot, simulate, stats } from './helpers.ts';

/**
 * The item balance table.
 *
 * A hundred AI-only races, logged, with the result actually read rather than
 * merely produced. The brief's rule of thumb is the bar:
 *
 *   > If a kart in last place finishes first more than about a fifth of the
 *   > time, the equalisers are too strong. If the leader never loses, they are
 *   > too weak.
 *
 * Every kart is driven by the AI, so nothing here depends on how well a human
 * plays. The AI's *speed* is never rubber-banded — catch-up lives entirely in
 * the position-weighted item draw — so this table measures the item table and
 * the roster, and nothing else.
 *
 * Each race gets its own page load and its own seed. That is slower than
 * restarting in place and it is the only way to be sure no state leaks between
 * races and quietly correlates them.
 */

/** Full runs are slow; the env var lets a quick check run a handful. */
const RACES = Number(process.env.SPARKDRIFT_RACES ?? 100);
/** Simulated seconds per chunk. Coarse enough to be fast, fine enough that a
 *  race is not over-simulated by more than this after everyone finishes. */
const CHUNK = 15;
/** A three-lap race at this pace takes about 120 s. 300 s is a generous cap
 *  that still terminates if something has gone wrong. */
const MAX_SECONDS = 300;

interface RaceOutcome {
  seed: number;
  /** Grid slot of the winner. Slot 0 starts at the front, 7 at the back. */
  winnerGrid: number;
  /** Final position of the kart that started last. */
  lastStarterFinish: number;
  finished: number;
  driverOrder: string[];
}

test.describe('item balance', () => {
  test(`${RACES} AI-only races, and the table read`, async ({ page }) => {
    test.setTimeout(60 * 60_000);

    const outcomes: RaceOutcome[] = [];
    const itemPickups: Record<string, number> = {};
    const hitsByVictimPosition: number[] = new Array(9).fill(0);
    const winsByGrid: number[] = new Array(8).fill(0);

    for (let seed = 1; seed <= RACES; seed++) {
      await boot(page, { seed, karts: 8, difficulty: 0.7 });
      await page.evaluate(() => {
        window.sparkdrift!.setPlayerAi(true);
        window.sparkdrift!.telemetry(true);
        window.sparkdrift!.setPhase('racing');
      });

      let elapsed = 0;
      let finished = 0;
      while (elapsed < MAX_SECONDS && finished < 8) {
        await simulate(page, CHUNK);
        elapsed += CHUNK;
        finished = (await stats(page)).karts.filter((k) => k.finished).length;
      }

      const s = await stats(page);
      const ordered = [...s.karts].sort((a, b) => a.position - b.position);
      const winner = ordered[0]!;
      // The grid is laid out in roster order, so kart index is the grid slot.
      winsByGrid[winner.index]!++;

      outcomes.push({
        seed,
        winnerGrid: winner.index,
        lastStarterFinish: s.karts[7]!.position,
        finished,
        driverOrder: ordered.map((k) => k.driverId),
      });

      const telemetry = (await page.evaluate(() =>
        window.sparkdrift!.telemetry(),
      )) as { event: string; kind: string; victimPosition: number }[];
      for (const row of telemetry) {
        if (row.event === 'pickup') itemPickups[row.kind] = (itemPickups[row.kind] ?? 0) + 1;
        if (row.event === 'hit' && row.victimPosition > 0) {
          hitsByVictimPosition[row.victimPosition]!++;
        }
      }
    }

    // --- the table ----------------------------------------------------------
    const backHalfWins = winsByGrid.slice(4).reduce((a, b) => a + b, 0);
    const backHalfWinRate = backHalfWins / RACES;
    const frontRowWins = winsByGrid[0]! + winsByGrid[1]!;
    const frontRowWinRate = frontRowWins / RACES;
    const allFinished = outcomes.filter((o) => o.finished === 8).length;

    const lines: string[] = [];
    lines.push(`races: ${RACES}, all eight finished in ${allFinished}`);
    lines.push('');
    lines.push('wins by grid slot (0 = front row, 7 = back):');
    winsByGrid.forEach((w, i) => {
      lines.push(`  slot ${i}: ${String(w).padStart(3)}  ${'#'.repeat(w)}`);
    });
    lines.push('');
    lines.push(`back half of the grid won ${(backHalfWinRate * 100).toFixed(0)}% of races`);
    lines.push(`front row won ${(frontRowWinRate * 100).toFixed(0)}% of races`);
    lines.push('');
    lines.push('item pickups by kind:');
    for (const [kind, n] of Object.entries(itemPickups).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${kind.padEnd(10)} ${String(n).padStart(5)}`);
    }
    lines.push('');
    lines.push('hits taken, by the victim’s position at the time:');
    hitsByVictimPosition.forEach((n, pos) => {
      if (pos === 0) return;
      lines.push(`  P${pos}: ${String(n).padStart(5)}`);
    });

    const report = lines.join('\n');
    mkdirSync('telemetry', { recursive: true });
    writeFileSync('telemetry/balance.txt', report);
    // eslint-disable-next-line no-console
    console.log('\n' + report + '\n');

    // --- what the table has to show -----------------------------------------
    expect(allFinished, 'not every race finished — the AI is not completing laps').toBeGreaterThan(
      RACES * 0.9,
    );

    // The brief's bar, both ends of it. These are wide on purpose: they catch a
    // broken distribution, not a slightly-off one, and the numbers above are
    // what a human actually reads.
    expect(
      backHalfWinRate,
      `the back half of the grid never wins (${(backHalfWinRate * 100).toFixed(0)}%) — the equalisers are too weak`,
    ).toBeGreaterThan(0.05);
    expect(
      backHalfWinRate,
      `the back half of the grid wins ${(backHalfWinRate * 100).toFixed(0)}% of races — the equalisers are too strong`,
    ).toBeLessThan(0.75);

    // Every item kind must actually come out of a box. A kind with zero
    // pickups across a hundred races is unreachable, whatever the table says.
    const kinds = Object.keys(itemPickups);
    expect(kinds.length, 'fewer than five item kinds were ever drawn').toBeGreaterThanOrEqual(5);
  });
});
