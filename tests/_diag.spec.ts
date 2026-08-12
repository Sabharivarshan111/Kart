import { test } from '@playwright/test';
import { boot, stats, teleport } from './helpers.ts';

const LAP_COPPER = 791;

test('diag lateral roundtrip', async ({ page }) => {
  await boot(page, { karts: 1 });
  await page.evaluate(() => window.sparkdrift!.setPhase('racing'));
  for (const u of [0, 100, 200, 300, 400]) {
    for (const lat of [-30, -8, -4, -2, 0, 2, 4, 8, 30]) {
      await teleport(page, 0, u, lat, 0);
      const k = (await stats(page)).karts[0]!;
      // eslint-disable-next-line no-console
      console.log(
        `asked u=${u} lat=${lat} -> u=${k.u.toFixed(1)} lat=${k.lateral.toFixed(3)} surf=${k.surface} onRoad=${k.onRoad} d2e=${k.distanceToEdge.toFixed(2)} x=${k.x.toFixed(1)} z=${k.z.toFixed(1)}`,
      );
    }
  }
  void LAP_COPPER;
});
