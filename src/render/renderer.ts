import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { Theme } from '../core/palette.ts';
import { LAYER_OUTLINE } from './celmaterial.ts';
import { CompositePass, type EdgeUniformState } from './edges.ts';
import { GBuffer } from './gbuffer.ts';

/**
 * Render orchestration.
 *
 * Pass order (ARCHITECTURE.md §7):
 *   1. beauty  — cel pass + inverted-hull outlines, into an offscreen target
 *   2. gbuffer — view normal + linear depth + object id, outline layer excluded
 *   3. composite — Sobel over the G-buffer, then the speed effects, to screen
 *
 * Two separate jobs are kept separate here, deliberately:
 *   - the **quality tier** is resolved once at load and decides *structure*
 *     (mesh density, crowd counts, buffer sizes, frame budget);
 *   - the **adaptive controller** decides *resolution* continuously.
 * Letting one do the other's job is how a device ends up rebuilding its track
 * mesh mid-corner.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface TierSettings {
  tier: QualityTier;
  /** Station stride for the track mesh. Structural: set once. */
  trackDensity: number;
  /** G-buffer resolution relative to the beauty buffer. */
  gbufferScale: number;
  sceneryCount: number;
  /** Frame budget in ms that the adaptive controller aims at. */
  frameBudgetMs: number;
  maxParticles: number;
}

/**
 * Resolved **once at load** from what the device reports. Deliberately coarse:
 * device detection is unreliable and a wrong guess that only changes structure
 * is recoverable through the graphics panel, whereas a wrong guess that
 * re-tiers mid-race is not.
 */
export function resolveTier(): TierSettings {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const touch =
    typeof navigator !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));

  // A high-DPR touch device with few cores is a phone, whatever it calls
  // itself. The DPR test alone flags high-end laptops; the core test alone
  // flags recent phones as desktops.
  if (touch && cores <= 6) {
    return {
      tier: 'low',
      trackDensity: 2,
      gbufferScale: 0.5,
      sceneryCount: 90,
      frameBudgetMs: 1000 / 60,
      maxParticles: 120,
    };
  }
  if (touch || dpr > 2 || cores <= 4) {
    return {
      tier: 'medium',
      trackDensity: 1,
      gbufferScale: 0.5,
      sceneryCount: 170,
      frameBudgetMs: 1000 / 60,
      maxParticles: 260,
    };
  }
  return {
    tier: 'high',
    trackDensity: 1,
    gbufferScale: 1.0,
    sceneryCount: 260,
    frameBudgetMs: 1000 / 60,
    maxParticles: 420,
  };
}

export interface RenderOptions {
  canvas: HTMLCanvasElement;
  theme: Theme;
  tier: TierSettings;
}

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly gbuffer: GBuffer;
  readonly composite: CompositePass;
  readonly tier: TierSettings;

  private beauty: THREE.WebGLRenderTarget;
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;

  /** Adaptive resolution scale. Floor is deliberately high — see CONFIG. */
  private scale: number = CONFIG.quality.scaleCeiling;
  adaptive = true;
  private frameAccum = 0;
  private frameCount = 0;

  constructor(opts: RenderOptions) {
    this.tier = opts.tier;
    this.gl = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // the outline pass is the anti-aliasing that matters here
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.autoClear = false;
    this.gl.setClearColor(0x000000, 1);

    this.beauty = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    // Deliberately linear. The composite pass does the one and only
    // linear-to-sRGB conversion, at the end of the chain; marking this target
    // sRGB would convert on write and then convert again on display.
    this.beauty.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.gbuffer = new GBuffer(1, 1, opts.tier.gbufferScale);
    this.composite = new CompositePass(opts.theme);
  }

  /**
   * Size from `visualViewport` where it exists — Android's URL bar moves
   * `innerHeight` by around 110 px and a layout driven by it jumps every time
   * the bar hides.
   */
  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.pixelRatio = Math.min(
      typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      CONFIG.quality.maxDevicePixelRatio,
    );
    this.applySize();
  }

  private applySize(): void {
    const w = Math.max(1, Math.round(this.cssWidth * this.pixelRatio * this.scale));
    const h = Math.max(1, Math.round(this.cssHeight * this.pixelRatio * this.scale));
    this.gl.setPixelRatio(1); // we do our own scaling, so keep Three out of it
    this.gl.setSize(this.cssWidth, this.cssHeight, true);
    this.beauty.setSize(w, h);
    this.gbuffer.setSize(w, h, this.tier.gbufferScale);
  }

  /** Render resolution in device pixels, for the graphics panel and the tests. */
  get renderSize(): { width: number; height: number; scale: number } {
    return { width: this.beauty.width, height: this.beauty.height, scale: this.scale };
  }

  setScale(scale: number): void {
    const clamped = Math.min(
      CONFIG.quality.scaleCeiling,
      Math.max(CONFIG.quality.scaleFloor, scale),
    );
    if (Math.abs(clamped - this.scale) < 0.001) return;
    this.scale = clamped;
    this.applySize();
  }

  /**
   * Adaptive resolution. Reacts on a one-second window rather than per frame:
   * a single slow frame is a garbage collection, not a trend, and reacting to
   * it makes the resolution visibly pump.
   */
  adapt(frameSeconds: number): void {
    if (!this.adaptive) return;
    this.frameAccum += frameSeconds * 1000;
    this.frameCount++;
    if (this.frameAccum < CONFIG.quality.adaptWindowSeconds * 1000) return;
    const mean = this.frameAccum / this.frameCount;
    this.frameAccum = 0;
    this.frameCount = 0;
    const budget = this.tier.frameBudgetMs;
    if (mean > budget * 1.12) this.setScale(this.scale - CONFIG.quality.scaleStep);
    else if (mean < budget * 0.82) this.setScale(this.scale + CONFIG.quality.scaleStep);
  }

  render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    state: EdgeUniformState,
    drawEdges = true,
    drawOutlines = true,
    target: THREE.WebGLRenderTarget | null = null,
  ): void {
    // --- 1. beauty: cel pass + outline hulls -------------------------------
    // `drawOutlines` exists for the verification harness: rendering the hull
    // pass and the Sobel pass separately is what lets a test prove the two line
    // systems are drawing *different* lines rather than the same one twice.
    if (drawOutlines) camera.layers.enable(LAYER_OUTLINE);
    else camera.layers.disable(LAYER_OUTLINE);
    this.gl.setRenderTarget(this.beauty);
    this.gl.clear(true, true, false);
    this.gl.render(scene, camera);

    // --- 2. G-buffer, outline hulls excluded -------------------------------
    if (drawEdges) {
      camera.layers.disable(LAYER_OUTLINE);
      const prevOverride = scene.overrideMaterial;
      const prevBg = scene.background;
      scene.overrideMaterial = this.gbuffer.material;
      scene.background = null;
      this.gl.setRenderTarget(this.gbuffer.target);
      // Clear to "very far away, no object". Sky texels keep this value, which
      // is what lets a silhouette against the sky still register as an edge
      // while the horizon itself does not.
      this.gl.setClearColor(new THREE.Color().setRGB(0.5, 0.5, 900), 0);
      this.gl.clear(true, true, false);
      this.gl.render(scene, camera);
      this.gl.setClearColor(0x000000, 1);
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
    }
    camera.layers.enable(LAYER_OUTLINE);

    // --- 3. composite ------------------------------------------------------
    this.composite.setInputs(this.beauty.texture, this.gbuffer.target.texture, this.gbuffer.texelSize);
    this.composite.setState({ ...state, edgesEnabled: state.edgesEnabled && drawEdges });
    this.composite.render(this.gl, target);
  }

  /**
   * Render one frame into an offscreen target and read it back.
   *
   * Used only by the harness. `preserveDrawingBuffer` would let a test read the
   * canvas directly, but it costs a full-screen copy on every frame of normal
   * play on exactly the devices that can least afford one — so the capture path
   * is explicit instead.
   */
  capture(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    state: EdgeUniformState,
    drawEdges: boolean,
    drawOutlines: boolean,
  ): { width: number; height: number; pixels: Uint8Array } {
    const w = this.beauty.width;
    const h = this.beauty.height;
    if (!this.captureTarget || this.captureTarget.width !== w || this.captureTarget.height !== h) {
      this.captureTarget?.dispose();
      this.captureTarget = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
    }
    this.render(scene, camera, state, drawEdges, drawOutlines, this.captureTarget);
    const pixels = new Uint8Array(w * h * 4);
    this.gl.readRenderTargetPixels(this.captureTarget, 0, 0, w, h, pixels);
    this.gl.setRenderTarget(null);
    return { width: w, height: h, pixels };
  }

  private captureTarget: THREE.WebGLRenderTarget | null = null;

  dispose(): void {
    this.beauty.dispose();
    this.gbuffer.dispose();
    this.composite.dispose();
    this.gl.dispose();
  }
}
