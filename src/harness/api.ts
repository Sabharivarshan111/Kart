import type { Controls, Phase } from '../core/contracts.ts';

/**
 * The verification API, exposed on `window.sparkdrift` in **every** build,
 * production included. A harness that only exists in dev tests something other
 * than what ships.
 *
 * The rules this serves (ARCHITECTURE.md §6):
 *   - never claim a visual result not seen in a captured frame;
 *   - never claim a performance result not measured on the real rAF clock;
 *   - assert geometrically, not by eye;
 *   - assert things are *correct*, not merely present.
 *
 * That last one is why `stats()` reports bounding boxes and spreads rather than
 * counts: a count assertion passes for a hundred objects sitting in one
 * invisible pile at the origin.
 */

export interface KartStats {
  index: number;
  isPlayer: boolean;
  driverId: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  slip: number;
  drifting: boolean;
  driftTier: number;
  driftCharge: number;
  boostTime: number;
  airborne: boolean;
  airtime: number;
  surface: number;
  onRoad: boolean;
  distanceToEdge: number;
  u: number;
  lateral: number;
  lap: number;
  checkpoint: number;
  progress: number;
  position: number;
  spunOut: boolean;
  finished: boolean;
  finishTime: number;
  respawns: number;
  item: string | null;
  wheelsOnGround: number;
}

export interface HarnessStats {
  phase: Phase;
  time: number;
  seed: number;
  trackId: string;
  lapLength: number;
  karts: KartStats[];
  /** Screen-space rectangles of every HUD element and touch control, in CSS
   *  pixels, for the geometric overlap assertions the brief demands. */
  uiRects: Record<string, { x: number; y: number; w: number; h: number }>;
  render: {
    width: number;
    height: number;
    scale: number;
    tier: string;
    gbufferWidth: number;
    gbufferHeight: number;
    triangles: number;
    drawCalls: number;
  };
  /** Bounding box of the scenery instance set, so a test can assert the
   *  instances are genuinely spread and not stacked on the origin. */
  scenerySpread: { count: number; sizeX: number; sizeY: number; sizeZ: number } | null;
  items: {
    active: number;
    /** Per-entity so a test can assert a projectile actually moved and hit. */
    entities: { kind: string; x: number; y: number; z: number; age: number; ownerIndex: number }[];
    boxesAvailable: number;
  };
  frame: {
    samples: number;
    p50: number;
    p95: number;
    worst: number;
    overBudget: number;
    clampedFrames: number;
  };
}

export interface SparkdriftHarness {
  /** Resolves once the first frame has been presented. */
  ready: Promise<void>;
  version: string;

  /** Deterministic fixed-step advance. Never waits on vsync; says nothing
   *  about frame rate, by design. */
  simulate(seconds: number, dt?: number): void;

  setPhase(phase: Phase): void;
  /** Override the controls of a kart. Index 0 is the player. Passing null
   *  hands the kart back to its normal controller. */
  setControls(index: number, controls: Partial<Controls> | null): void;
  setCameraPreset(name: string): void;
  stats(): HarnessStats;
  teleport(index: number, u: number, lateral: number, speed?: number, heading?: number): void;
  /** World-space bounding box of a named object, for geometric assertions. */
  bounds(name: string): { min: [number, number, number]; max: [number, number, number] } | null;

  /** Load a different track without a page reload — test-only convenience.
   *  The game itself always reloads (ARCHITECTURE.md §3.2). */
  loadTrack(id: string): Promise<void>;
  resetFrameStats(): void;
  /** Force a resolution scale, bypassing the adaptive controller. */
  setResolutionScale(scale: number | null): void;
  setReducedMotion(on: boolean): void;
  /** Fire an audio cue by name; used by the audio self-test. */
  audioSelfTest(): Promise<Record<string, { peak: number; rms: number }>>;
  /** Renders the outline pass and the Sobel pass separately and classifies
   *  every ink pixel as silhouette or interior. Proves the two line systems
   *  are not drawing the same line twice. */
  analyseEdges(): {
    width: number;
    height: number;
    outlineOnly: { ink: number; unique: number; againstSky: number; againstGeometry: number };
    sobelOnly: { ink: number; unique: number; againstSky: number; againstGeometry: number };
    both: { ink: number };
  };
  /** Item draw counts at a given race position, for the balance table. */
  sampleItemDistribution(position: number, n: number): Record<string, number>;
  /** The item telemetry log, for the balance table. */
  telemetry(enable?: boolean): unknown[];
}

declare global {
  interface Window {
    sparkdrift?: SparkdriftHarness;
  }
}

export {};
