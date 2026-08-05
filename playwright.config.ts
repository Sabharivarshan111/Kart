import { defineConfig, devices } from '@playwright/test';

/**
 * The verification harness runs against the **production build**, served
 * statically. Testing the dev server tests Vite's module graph, not the thing
 * that ships — and the single-file build is the artefact the brief asks for.
 *
 * A headless runner has no GPU: its frame times describe a software
 * rasteriser, and the performance suite says so in its own output rather than
 * pretending otherwise.
 */
export default defineConfig({
  testDir: './tests',
  // Screenshots and simulations are order-independent but GPU-bound; one worker
  // keeps frame timings from being contaminated by a parallel run.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    launchOptions: {
      // The pre-installed Chromium in this environment is a different build
      // number from the one @playwright/test pins, so point at it explicitly
      // rather than downloading a second copy.
      executablePath: process.env.SPARKDRIFT_CHROME ?? '/opt/pw-browsers/chromium',
      args: [
        // SwiftShader: without a GPU, WebGL2 otherwise fails to initialise
        // entirely and every test reports "no context" rather than a result.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-lcd-text',
      ],
    },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
