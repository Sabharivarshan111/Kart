import * as THREE from 'three';
import { CONFIG } from './core/config.ts';
import type { Controls, Phase, TrackSpec } from './core/contracts.ts';
import { SurfaceKind } from './core/contracts.ts';
import { copyControls, neutralControls } from './core/controls.ts';
import { FixedLoop } from './core/loop.ts';
import { clamp01 } from './core/mathx.ts';
import { Rng } from './core/rng.ts';
import { theme } from './core/palette.ts';
import { ROSTER } from './content/roster.ts';
import './content/themes.ts';
import { AudioEngine } from './audio/engine.ts';
import { AiDriver, buildRacingLine, type RacingLine } from './race/ai.ts';
import { ItemSystem, type ItemKind } from './race/items.ts';
import { Race, type RaceMode } from './race/rules.ts';
import { ChaseCamera, type CameraPreset } from './render/camera.ts';
import { ItemView } from './render/itemview.ts';
import { KartView } from './render/kartview.ts';
import { Renderer, resolveTier, type TierSettings } from './render/renderer.ts';
import { World } from './render/world.ts';
import { Hud } from './ui/hud.ts';
import { InputSource } from './ui/input.ts';
import { DEFAULT_TOUCH_OPTIONS, TouchControls, type TouchOptions } from './ui/touch.ts';
import { isOffRoad, needsRespawn, resolveKartPair, resolveWalls, respawn } from './vehicle/collision.ts';
import { Kart } from './vehicle/kart.ts';

/**
 * The game: everything wired together, stepped at a fixed 120 Hz and rendered
 * with interpolation.
 *
 * Ownership discipline from ARCHITECTURE.md §2 holds here — this module
 * coordinates, it does not reach inside anything. It never computes a ground
 * height (the surface does), never moves a kart directly (the vehicle does),
 * and never decides an AI's line (the AI does).
 */

export interface GameOptions {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  spec: TrackSpec;
  seed: number;
  mode?: RaceMode;
  kartCount?: number;
  playerDriverId?: string;
  difficulty?: number;
  tier?: TierSettings;
  touchOptions?: TouchOptions;
}

export class Game {
  readonly world: World;
  readonly renderer: Renderer;
  readonly camera: ChaseCamera;
  readonly race: Race;
  readonly items: ItemSystem;
  readonly hud: Hud;
  readonly touch: TouchControls;
  readonly input = new InputSource();
  readonly karts: Kart[] = [];
  readonly line: RacingLine;
  readonly loop: FixedLoop;
  readonly spec: TrackSpec;
  readonly seed: number;

  private readonly views: KartView[] = [];
  private readonly ai: (AiDriver | null)[] = [];
  private readonly itemView: ItemView;
  private readonly controlBuffers: Controls[] = [];
  private readonly harnessOverrides: (Partial<Controls> | null)[] = [];
  private readonly rng: Rng;
  private audio: AudioEngine | null = null;
  private audioCtx: AudioContext | null = null;

  private player: Kart;
  private time = 0;
  private paused = false;
  private lastCountdownBeep = 99;
  private reduceMotion = false;
  private forcedScale: number | null = null;

  constructor(opts: GameOptions) {
    this.spec = opts.spec;
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed);
    const tier = opts.tier ?? resolveTier();
    const trackTheme = theme(opts.spec.theme.name);

    this.world = new World(opts.spec, trackTheme, tier.sceneryCount, tier.trackDensity);
    this.renderer = new Renderer({ canvas: opts.canvas, theme: trackTheme, tier });
    this.camera = new ChaseCamera(1);

    const count = Math.min(opts.kartCount ?? CONFIG.race.kartCount, ROSTER.length);
    const playerId = opts.playerDriverId ?? ROSTER[0]!.id;

    // The player's driver first, then the rest of the roster in order. Stable
    // for a given roster so a named screenshot always has the same grid.
    const order = [
      ROSTER.find((d) => d.id === playerId) ?? ROSTER[0]!,
      ...ROSTER.filter((d) => d.id !== playerId),
    ].slice(0, count);

    for (let i = 0; i < order.length; i++) {
      const kart = new Kart(i, i === 0, order[i]!);
      this.karts.push(kart);
      this.controlBuffers.push(neutralControls());
      this.harnessOverrides.push(null);
    }
    this.player = this.karts[0]!;

    this.line = buildRacingLine(this.world.surface);
    this.race = new Race(opts.spec, this.world.surface, this.karts, opts.mode ?? 'grand-prix');
    this.items = new ItemSystem(opts.spec, this.world.surface, this.karts.length, this.rng.fork(7));

    for (let i = 0; i < this.karts.length; i++) {
      this.views.push(new KartView(this.karts[i]!, this.world));
      if (i === 0 && (opts.mode ?? 'grand-prix') !== 'arena') {
        this.ai.push(null);
      } else {
        const driver = new AiDriver(
          this.karts[i]!,
          this.line,
          this.world.surface,
          this.rng.fork(100 + i),
          { difficulty: opts.difficulty ?? 0.6 },
        );
        driver.shouldUseItem = (k) => this.items.aiShouldUse(k.index, this.karts, this.race);
        this.ai.push(driver);
      }
    }
    // Index 0 is always the player in a race; give it no AI.
    this.ai[0] = null;

    this.itemView = new ItemView(this.items, this.world, this.karts.length);

    this.hud = new Hud(this.karts.length);
    this.hud.setTrack(this.world.surface);
    this.touch = new TouchControls(opts.touchOptions ?? DEFAULT_TOUCH_OPTIONS);
    opts.overlay.appendChild(this.hud.root);
    opts.overlay.appendChild(this.touch.root);
    this.touch.setVisible(false);
    this.touch.onPause = () => this.togglePause();

    this.input.attach();
    this.loop = new FixedLoop(
      (dt) => this.step(dt),
      (alpha, frameSeconds) => this.render(alpha, frameSeconds),
    );
  }

  // =========================================================================
  //  Simulation
  // =========================================================================
  private step(dt: number): void {
    if (this.paused) return;
    this.time += dt;

    const racing = this.race.phase === 'racing';

    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i]!;
      const buffer = this.controlBuffers[i]!;
      this.gatherControls(i, buffer, dt);

      const gated = this.race.gateControls(i, buffer);
      this.race.checkStartBoost(i, buffer);

      // Item use is edge-triggered on the control struct, so holding the
      // button does not empty the slot the instant it refills.
      if (gated.useItem && racing) this.tryUseItem(i);

      kart.step(dt, gated, this.world.surface);
    }

    // Collision after every kart has moved, so the pair resolution sees the
    // same instant for both — resolving inside the movement loop makes the
    // outcome depend on kart index, which is a rank-ordering bug that only
    // shows up as "the player always loses bumps".
    for (const kart of this.karts) {
      const hit = resolveWalls(kart, this.world.surface);
      if (hit && hit.kart === this.player && hit.normalSpeed > 3) {
        this.camera.addShake(clamp01(hit.normalSpeed / 18) * 0.5);
        this.audio?.impact(clamp01(hit.normalSpeed / 16));
      }
    }
    for (let a = 0; a < this.karts.length; a++) {
      for (let b = a + 1; b < this.karts.length; b++) {
        const hit = resolveKartPair(this.karts[a]!, this.karts[b]!);
        if (hit && hit.closingSpeed > 4 && (hit.a === this.player || hit.b === this.player)) {
          this.camera.addShake(clamp01(hit.closingSpeed / 20) * 0.4);
          this.audio?.impact(clamp01(hit.closingSpeed / 18) * 0.7);
        }
      }
    }

    for (const kart of this.karts) {
      if (isOffRoad(kart.sample.surface) && needsRespawn(kart)) {
        respawn(kart, this.world.surface);
      }
    }

    this.items.step(dt, this.karts, this.race);
    this.race.step(dt);

    this.reactToEvents();
  }

  private gatherControls(index: number, out: Controls, dt: number): void {
    const override = this.harnessOverrides[index];
    if (override) {
      // The harness drives directly. Still a `Controls` — the point of the one
      // struct is that a test cannot reach anything the player cannot.
      out.throttle = override.throttle ?? 0;
      out.brake = override.brake ?? 0;
      out.steer = override.steer ?? 0;
      out.drift = override.drift ?? false;
      out.useItem = override.useItem ?? false;
      out.lookBack = override.lookBack ?? false;
      return;
    }

    const ai = this.ai[index];
    if (ai) {
      ai.drive(dt, out, this.karts);
      return;
    }

    // Player: touch if it is visible, keyboard/gamepad otherwise. Both produce
    // the same struct, so nothing downstream knows or cares which was used.
    if (this.touch.visible) {
      copyControls(out, this.touch.poll(this.race.phase === 'racing'));
    } else {
      copyControls(out, this.input.poll(dt));
    }
  }

  private tryUseItem(index: number): void {
    if (this.items.shields[index]! > 0 && this.items.held[index] === null) {
      if (this.items.throwShield(index, this.karts, this.race)) {
        this.audio?.itemFire();
      }
      return;
    }
    const kind = this.items.held[index];
    if (kind === null) return;
    if (this.items.use(index, this.karts, this.race)) {
      if (index === this.player.index) {
        if (kind === 'surge' || kind === 'phase') this.audio?.boost();
        else this.audio?.itemFire();
      }
    }
  }

  private reactToEvents(): void {
    const p = this.player;
    if (p.hopFired) this.audio?.driftTier(1);
    if (p.boostFired) {
      this.audio?.boost();
      this.camera.addShake(0.35);
    }
    if (p.landedHard) this.camera.addShake(0.3);
    for (const ev of this.race.lapEvents) {
      if (ev.index === this.player.index) this.audio?.lap();
    }
  }

  // =========================================================================
  //  Rendering
  // =========================================================================
  private render(alpha: number, frameSeconds: number): void {
    const dtVisual = Math.min(0.1, frameSeconds);

    for (const view of this.views) view.update(alpha, this.time);
    this.itemView.update(this.time, this.karts);

    const lookBack = this.controlBuffers[this.player.index]!.lookBack;
    this.camera.reduceMotion = this.reduceMotion;
    this.camera.update(dtVisual, this.player, alpha, lookBack);
    this.world.followCamera(this.camera.camera);

    const heldItem: ItemKind | null =
      this.items.held[this.player.index] ??
      (this.items.shields[this.player.index]! > 0 ? 'husk' : null);
    this.hud.update(
      this.race,
      this.player,
      this.karts,
      heldItem,
      this.items.homingWarning[this.player.index]! > 0,
    );

    this.updateAudio();

    const speedFactor = clamp01(this.player.speed / CONFIG.render.streakFullSpeed);
    const boostFactor = this.player.boostTime > 0 ? 1 : 0;
    this.renderer.adapt(frameSeconds);
    if (this.forcedScale !== null) this.renderer.setScale(this.forcedScale);
    this.renderer.render(this.world.scene, this.camera.camera, {
      speedFactor,
      boostFactor,
      chromatic: boostFactor * (this.reduceMotion ? 0.3 : 1),
      edgesEnabled: true,
      streaksEnabled: !this.reduceMotion,
      vignette: 1,
    });
  }

  private updateAudio(): void {
    const a = this.audio;
    if (!a) return;
    const p = this.player;
    const rpm = clamp01(p.speed / CONFIG.kart.topSpeed);
    a.setEngine(rpm, this.controlBuffers[p.index]!.throttle, undefined);
    a.setScrub(clamp01(Math.abs(p.lateralSlip) / CONFIG.kart.grip.slipSaturation));
    a.setSurface(p.sample.surface, rpm);
    a.setCrowd(0.5);

    if (this.race.phase === 'countdown') {
      const n = Math.ceil(this.race.countdownRemaining());
      if (n !== this.lastCountdownBeep) {
        this.lastCountdownBeep = n;
        a.countdownBeep(n === 0);
      }
    }
  }

  // =========================================================================
  //  Lifecycle and controls
  // =========================================================================
  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    this.input.detach();
  }

  /** Audio needs a user gesture on every current browser. Called from the
   *  first pointer or key event, and safe to call repeatedly. */
  enableAudio(): void {
    if (this.audio) {
      void this.audioCtx?.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.audioCtx = new Ctor();
      this.audio = new AudioEngine(this.audioCtx);
      this.audio.start(this.audioCtx.currentTime);
    } catch {
      // A blocked or unavailable AudioContext must not take the game with it.
      this.audio = null;
      this.audioCtx = null;
    }
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
    this.camera.setAspect(width / Math.max(1, height));
    this.world.resize(height * Math.min(devicePixelRatio || 1, CONFIG.quality.maxDevicePixelRatio), this.camera.fieldOfView);
  }

  setTouchEnabled(on: boolean): void {
    this.touch.setVisible(on);
    this.hud.setTouchLayout(on);
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.race.phase = this.paused ? 'paused' : this.race.phase === 'paused' ? 'racing' : this.race.phase;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setReducedMotion(on: boolean): void {
    this.reduceMotion = on;
  }

  setResolutionScale(scale: number | null): void {
    this.forcedScale = scale;
    this.renderer.adaptive = scale === null;
    if (scale !== null) this.renderer.setScale(scale);
  }

  setPhase(phase: Phase): void {
    this.race.phase = phase;
    if (phase === 'racing' && this.race.time < 0) this.race.time = 0;
  }

  setCameraPreset(name: string): void {
    this.camera.setPreset(name as CameraPreset);
  }

  /**
   * Hand the player's kart to an AI driver, for AI-only races.
   *
   * Used by the balance harness (a hundred races) and by the bug class 6 test,
   * which asserts no kart is ever off-road for more than a second across a full
   * AI-only race. Nothing about the kart changes — it is still driven through a
   * `Controls`, still collides through the same code — only who fills the
   * struct.
   */
  setPlayerAi(on: boolean): void {
    if (!on) {
      this.ai[0] = null;
      return;
    }
    if (this.ai[0]) return;
    const driver = new AiDriver(
      this.karts[0]!,
      this.line,
      this.world.surface,
      this.rng.fork(1),
      { difficulty: 0.7 },
    );
    driver.shouldUseItem = (k) => this.items.aiShouldUse(k.index, this.karts, this.race);
    this.ai[0] = driver;
  }

  setControlOverride(index: number, controls: Partial<Controls> | null): void {
    if (index < 0 || index >= this.harnessOverrides.length) return;
    this.harnessOverrides[index] = controls;
  }

  /** Deterministic advance for the harness. Never renders, never waits on
   *  vsync — its numbers say nothing about frame rate, by design. */
  simulate(seconds: number, dt = this.loop.dt): void {
    const steps = Math.max(0, Math.round(seconds / dt));
    for (let i = 0; i < steps; i++) this.step(dt);
  }

  teleport(index: number, u: number, lateral: number, speed = 0, heading?: number): void {
    const kart = this.karts[index];
    if (!kart) return;
    const station = this.world.surface.stationAt(u);
    const p = { x: 0, y: 0, z: 0 };
    this.world.surface.pointAt(u, lateral, p);
    const h = heading ?? Math.atan2(station.tx, station.tz);
    kart.placeAt(p.x, p.y + 0.4, p.z, h, speed);
    kart.hintU = u;
    this.world.surface.sample(kart.x, kart.z, kart.sample, u);
  }

  /** World bounding box of a named object, for geometric assertions. */
  bounds(name: string): { min: [number, number, number]; max: [number, number, number] } | null {
    let object: THREE.Object3D | null = null;
    if (name === 'scenery') object = this.world.sceneryMesh;
    else if (name.startsWith('kart')) {
      const idx = Number.parseInt(name.slice(4), 10) || 0;
      object = this.views[idx]?.group ?? null;
    } else if (name === 'track') {
      object = this.world.scene;
    }
    if (!object) return null;
    const box = new THREE.Box3().setFromObject(object);
    if (!Number.isFinite(box.min.x)) return null;
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
  }

  /**
   * Proof, in numbers, that the two line systems draw *different* lines.
   *
   * Four frames are rendered offscreen: no edges at all, outlines only, Sobel
   * only, and both. Ink is anything that matches the theme's ink colour in an
   * edged frame but did not already match it in the unedged one — so the
   * darkest cel band is never mistaken for a line.
   *
   * The decisive number is `sobelOnly.unique`: Sobel ink with **no** hull ink
   * anywhere within two pixels. Those are lines the inverted hull did not draw
   * and structurally cannot draw — a hull only ever produces a silhouette, so
   * anything it never covers is an interior line. That is what M3's "done when"
   * asks for, and unlike a background-colour test it holds whatever the subject
   * happens to be standing in front of.
   *
   * `againstSky` / `againstGeometry` are reported for context — they say where
   * each system's ink landed — but they are descriptive, not the gate.
   */
  analyseEdges(): {
    width: number;
    height: number;
    outlineOnly: { ink: number; unique: number; againstSky: number; againstGeometry: number };
    sobelOnly: { ink: number; unique: number; againstSky: number; againstGeometry: number };
    both: { ink: number };
  } {
    const state = {
      speedFactor: 0,
      boostFactor: 0,
      chromatic: 0,
      edgesEnabled: true,
      streaksEnabled: false,
      vignette: 0,
    };
    const scene = this.world.scene;
    const cam = this.camera.camera;

    const plain = this.renderer.capture(scene, cam, { ...state, edgesEnabled: false }, false, false);
    const outline = this.renderer.capture(scene, cam, { ...state, edgesEnabled: false }, false, true);
    const sobel = this.renderer.capture(scene, cam, state, true, false);
    const both = this.renderer.capture(scene, cam, state, true, true);

    const ink = this.world.theme.ink;
    const ir = (ink >> 16) & 0xff;
    const ig = (ink >> 8) & 0xff;
    const ib = ink & 0xff;
    // 34 per channel: wide enough to catch the ink after the composite's
    // vignette and rounding, tight enough to exclude the darkest cel band —
    // measured against this theme's own road colour, which sits ~70 away.
    const TOL = 34;
    const isInk = (p: Uint8Array, i: number) =>
      Math.abs(p[i]! - ir) < TOL && Math.abs(p[i + 1]! - ig) < TOL && Math.abs(p[i + 2]! - ib) < TOL;

    // Background in the reference frame = the sky, which no geometry writes.
    const skyTop = this.world.theme.skyTop;
    const skyHz = this.world.theme.skyHorizon;
    const nearSky = (p: Uint8Array, i: number) => {
      const r = p[i]!, g = p[i + 1]!, b = p[i + 2]!;
      const near = (hex: number) =>
        Math.abs(r - ((hex >> 16) & 0xff)) < 60 &&
        Math.abs(g - ((hex >> 8) & 0xff)) < 60 &&
        Math.abs(b - (hex & 0xff)) < 60;
      return near(skyTop) || near(skyHz);
    };

    const w = plain.width;
    const h = plain.height;

    /** Ink mask for a frame, excluding anything already dark unedged. */
    const maskOf = (frame: { pixels: Uint8Array }): Uint8Array => {
      const mask = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) {
        const i = p * 4;
        if (isInk(frame.pixels, i) && !isInk(plain.pixels, i)) mask[p] = 1;
      }
      return mask;
    };

    const outlineMask = maskOf(outline);
    const sobelMask = maskOf(sobel);
    const bothMask = maskOf(both);

    /** True when any set pixel of `other` lies within Chebyshev radius 2. The
     *  tolerance absorbs the half-pixel disagreement between a hull expanded in
     *  view space and a Sobel run on a half-resolution G-buffer — without it,
     *  the same line found by both systems would count as unique to each. */
    const nearOther = (other: Uint8Array, x: number, y: number): boolean => {
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (other[yy * w + xx]) return true;
        }
      }
      return false;
    };

    const classify = (mask: Uint8Array, other: Uint8Array) => {
      let ink = 0;
      let unique = 0;
      let againstSky = 0;
      let againstGeometry = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (!mask[p]) continue;
          ink++;
          if (!nearOther(other, x, y)) unique++;
          if (nearSky(plain.pixels, p * 4)) againstSky++;
          else againstGeometry++;
        }
      }
      return { ink, unique, againstSky, againstGeometry };
    };

    let bothInk = 0;
    for (let p = 0; p < bothMask.length; p++) if (bothMask[p]) bothInk++;

    return {
      width: w,
      height: h,
      outlineOnly: classify(outlineMask, sobelMask),
      sobelOnly: classify(sobelMask, outlineMask),
      both: { ink: bothInk },
    };
  }

  sceneryStats(): { count: number; sizeX: number; sizeY: number; sizeZ: number } | null {
    const mesh = this.world.sceneryMesh;
    if (!mesh) return null;
    // Bug class 7 made measurable: an instance set that forgot `instanceMatrix`
    // has the right count and a bounding box the size of one instance.
    const box = new THREE.Box3().setFromObject(mesh);
    return {
      count: mesh.count,
      sizeX: box.max.x - box.min.x,
      sizeY: box.max.y - box.min.y,
      sizeZ: box.max.z - box.min.z,
    };
  }

  get playerKart(): Kart {
    return this.player;
  }

  get surfaceKinds(): typeof SurfaceKind {
    return SurfaceKind;
  }

  dispose(): void {
    this.stop();
    this.audio?.dispose();
    void this.audioCtx?.close();
    this.world.dispose();
    this.renderer.dispose();
    this.hud.root.remove();
    this.touch.root.remove();
  }
}
