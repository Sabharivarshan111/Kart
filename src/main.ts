import { runAudioSelfTest } from './audio/selftest.ts';
import { TRACKS, trackById } from './content/tracks/index.ts';
import { validateTrack } from './track/validator.ts';
import { theme } from './core/palette.ts';
import './content/themes.ts';
import { UI } from './core/palette.ts';
import { seedFromLocation } from './core/rng.ts';
import type { Phase } from './core/contracts.ts';
import { Game } from './game.ts';
import type { HarnessStats, KartStats, SparkdriftHarness } from './harness/api.ts';
import { resolveTier } from './render/renderer.ts';
import { Hud } from './ui/hud.ts';
import { TouchControls } from './ui/touch.ts';
import { Shell } from './ui/shell.ts';

/**
 * Boot.
 *
 * The harness is installed in **every** build, production included — a harness
 * that only exists in dev tests something other than what ships.
 */

const params = new URLSearchParams(location.search);
const seed = seedFromLocation(1);
const trackId = params.get('track') ?? TRACKS[0]!.id;
const kartCount = clampInt(params.get('karts'), 1, 8, 8);
const difficulty = clampFloat(params.get('difficulty'), 0, 1, 0.6);
const forceTouch = params.get('touch') === '1';
const mode = (params.get('mode') as 'grand-prix' | 'time-trial' | 'arena' | null) ?? 'grand-prix';

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
function clampFloat(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---------------------------------------------------------------------------
// DOM scaffolding. Built in code so the whole game is one HTML file with no
// markup of its own to keep in sync.
// ---------------------------------------------------------------------------
const app = document.getElementById('app')!;
const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: dark; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: ${UI.backdrop}; color: ${UI.ink};
    overflow: hidden;
    /* Suppress pull-to-refresh, double-tap zoom and long-press selection —
       all three fire during normal play on Android and all three are
       destructive mid-corner. */
    overscroll-behavior: none;
    touch-action: none;
    -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #app { position: fixed; inset: 0; }
  /* 100dvh, not 100vh: on Android the URL bar moves innerHeight by ~110 px and
     a vh-sized canvas jumps every time the bar hides. */
  #sd-canvas { display: block; width: 100%; height: 100dvh; }
  ${Hud.css()}
  ${TouchControls.css()}
  ${Shell.css()}
`;
document.head.appendChild(style);

const canvas = document.createElement('canvas');
canvas.id = 'sd-canvas';
app.appendChild(canvas);

const overlay = document.createElement('div');
overlay.id = 'sd-overlay';
app.appendChild(overlay);

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------
const tier = resolveTier();
let game = new Game({
  canvas,
  overlay,
  spec: trackById(trackId),
  seed,
  mode,
  kartCount,
  difficulty,
  tier,
});

const isTouchDevice =
  forceTouch ||
  (typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)));
game.setTouchEnabled(isTouchDevice);

/**
 * Viewport from `visualViewport` where it exists. `innerHeight` on Android
 * includes the URL bar's space and changes by ~110 px when it hides, which
 * makes a layout driven by it jump on the first scroll gesture of every race.
 */
function currentViewport(): { width: number; height: number } {
  const vv = window.visualViewport;
  if (vv) return { width: vv.width, height: vv.height };
  return { width: window.innerWidth, height: window.innerHeight };
}

function applyResize(): void {
  const { width, height } = currentViewport();
  game.resize(width, height);
}
applyResize();

window.addEventListener('resize', applyResize);
window.visualViewport?.addEventListener('resize', applyResize);
window.visualViewport?.addEventListener('scroll', applyResize);

// Fullscreen, orientation lock and a wake lock, each behind a feature test and
// a catch. All three are refused in plenty of legitimate situations and none of
// them is worth an unhandled rejection.
let gesturesApplied = false;
async function firstGesture(): Promise<void> {
  game.enableAudio();
  if (gesturesApplied) return;
  gesturesApplied = true;
  if (!isTouchDevice) return;
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch { /* refused: not fatal, the game plays windowed */ }
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    await orientation?.lock?.('landscape');
  } catch { /* unsupported on iOS and in most desktop browsers */ }
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } })
      .wakeLock?.request('screen');
  } catch { /* denied or unavailable */ }
}
window.addEventListener('pointerdown', () => void firstGesture(), { passive: true });
window.addEventListener('keydown', () => void firstGesture(), { passive: true });

game.start();

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
// Without `race=1` the shell takes over on load and shows the title screen over
// an AI race running as the backdrop. With it, the game is already racing and
// the shell is only the pause menu and the results screen.
//
// The verification harness always passes `race=1` (see tests/helpers.ts): a
// suite that had to click through four menus to reach a corner would be testing
// the menus, and every frame it captured would be one navigation change away
// from breaking.
const shell = new Shell({ game, overlay, params });
shell.start();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let readyResolve: () => void = () => {};
const ready = new Promise<void>((r) => {
  readyResolve = r;
});
// Resolve after two frames: one to build the scene, one to have actually
// presented it. A test that screenshots on the first frame captures a clear.
requestAnimationFrame(() => requestAnimationFrame(() => readyResolve()));

function kartStats(index: number): KartStats {
  const k = game.karts[index]!;
  const st = game.race.states[index]!;
  return {
    index,
    isPlayer: k.isPlayer,
    driverId: k.driver.id,
    x: k.x,
    y: k.y,
    z: k.z,
    heading: k.heading,
    speed: k.speed,
    slip: k.lateralSlip,
    drifting: k.drifting,
    driftTier: k.driftTier,
    driftCharge: k.driftCharge,
    boostTime: k.boostTime,
    airborne: k.airborne,
    airtime: k.airtime,
    surface: k.sample.surface,
    onRoad: k.sample.onRoad,
    distanceToEdge: k.sample.distanceToEdge,
    u: k.sample.u,
    lateral: k.sample.lateral,
    lap: st.lap,
    checkpoint: st.nextCheckpoint,
    progress: st.progress,
    position: st.position,
    spunOut: k.spinOutTimer > 0,
    finished: st.finished,
    finishTime: st.finishTime,
    respawns: k.respawns,
    offTrackTimer: k.offTrackTimer,
    item: game.items.held[index] ?? null,
    wheelsOnGround: k.wheelsOnGround,
  };
}

function stats(): HarnessStats {
  const info = game.renderer.gl.info;
  const size = game.renderer.renderSize;
  const g = game.renderer.gbuffer.size;
  return {
    phase: game.race.phase,
    cameraRoll: game.camera.currentRoll,
    cameraFov: game.camera.fieldOfView,
    time: game.race.time,
    seed: game.seed,
    trackId: game.spec.id,
    lapLength: game.race.lapLength,
    karts: game.karts.map((_, i) => kartStats(i)),
    uiRects: { ...game.hud.rects(), ...game.touch.rects() },
    render: {
      width: size.width,
      height: size.height,
      scale: size.scale,
      tier: game.renderer.tier.tier,
      gbufferWidth: g.width,
      gbufferHeight: g.height,
      triangles: info.render.triangles,
      drawCalls: info.render.calls,
    },
    scenerySpread: game.sceneryStats(),
    items: {
      active: game.items.entities.filter((e) => e.alive).length,
      entities: game.items.entities
        .filter((e) => e.alive)
        .map((e) => ({
          kind: e.kind,
          x: e.x,
          y: e.y,
          z: e.z,
          age: e.age,
          ownerIndex: e.ownerIndex,
        })),
      boxesAvailable: game.items.boxesAvailable,
    },
    frame: game.loop.frameStats(),
  };
}

const harness: SparkdriftHarness = {
  ready,
  version: '0.1.0',
  simulate: (seconds, dt) => game.simulate(seconds, dt),
  setPhase: (phase: Phase) => game.setPhase(phase),
  setControls: (index, controls) => game.setControlOverride(index, controls),
  setCameraPreset: (name) => game.setCameraPreset(name),
  stats,
  teleport: (index, u, lateral, speed, heading) => game.teleport(index, u, lateral, speed, heading),
  bounds: (name) => game.bounds(name),
  loadTrack: async (id: string) => {
    // Test-only. The game itself reloads the page on a track change
    // (ARCHITECTURE.md §3.2) rather than hot-swapping materials.
    const touchWasOn = game.touch.visible;
    game.dispose();
    game = new Game({
      canvas,
      overlay,
      spec: trackById(id),
      seed,
      mode,
      kartCount,
      difficulty,
      tier,
    });
    game.setTouchEnabled(touchWasOn);
    applyResize();
    game.start();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  },
  resetFrameStats: () => game.loop.resetFrameStats(),
  setResolutionScale: (scale) => game.setResolutionScale(scale),
  setReducedMotion: (on) => game.setReducedMotion(on),
  audioSelfTest: () => runAudioSelfTest(),
  analyseEdges: () => game.analyseEdges(),
  sampleItemDistribution: (position: number, n: number) =>
    game.items.sampleDistribution(position, n) as unknown as Record<string, number>,
  telemetry: (enable?: boolean) => {
    if (enable !== undefined) game.items.telemetryEnabled = enable;
    return game.items.telemetry;
  },
  touchState: () => ({
    taps: game.touch.tapsRecognised,
    steer: game.touch.controls.steer,
    drift: game.touch.controls.drift,
    throttle: game.touch.controls.throttle,
  }),
  setPlayerAi: (on: boolean) => game.setPlayerAi(on),
  validateAllTracks: () =>
    TRACKS.map((spec) => {
      const report = validateTrack(spec, theme(spec.theme.name));
      return {
        trackId: report.trackId,
        ok: report.ok,
        issues: report.issues,
        measurements: report.measurements,
      };
    }),
};

window.sparkdrift = harness;
