import { CONFIG } from './config.ts';

/**
 * The fixed-step accumulator (ARCHITECTURE.md §4).
 *
 * Variable-step vehicle physics is non-deterministic, frame-rate dependent and
 * will explode on a slow frame. A boat handed a bad delta bobs; a kart handed
 * one is through a wall. So the simulation only ever advances in whole
 * `1/fixedHz` steps and the renderer interpolates with whatever is left over.
 *
 * This module owns the clock and nothing else. It does not touch game state.
 */

export type StepFn = (dt: number) => void;
export type RenderFn = (alpha: number, frameSeconds: number) => void;

export class FixedLoop {
  readonly dt: number;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private rafHandle = 0;

  /** Real frame intervals in ms, for the performance report. Sampled from the
   *  rAF clock, because a fixed-step harness never waits on vsync and its
   *  numbers say nothing about frame rate. */
  private readonly frameSamples: number[] = [];
  private sampleCap = 4096;

  /** Steps actually taken last frame, and whether the clamp bit. */
  lastStepCount = 0;
  clampedFrames = 0;
  totalFrames = 0;

  constructor(
    private readonly step: StepFn,
    private readonly render: RenderFn,
    hz = CONFIG.fixedHz,
  ) {
    this.dt = 1 / hz;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const tick = (now: number) => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private frame(now: number): void {
    const frameMs = now - this.lastTime;
    this.lastTime = now;
    this.totalFrames++;
    if (this.frameSamples.length < this.sampleCap) this.frameSamples.push(frameMs);

    this.accumulator += frameMs / 1000;

    const maxAccum = this.dt * CONFIG.maxStepsPerFrame;
    if (this.accumulator > maxAccum) {
      // Deliberately drop the backlog rather than spiral. Running slow is a
      // visible stutter; catching up 400 ms of physics in one frame is a kart
      // through a wall, and it makes the *next* frame worse too.
      this.accumulator = maxAccum;
      this.clampedFrames++;
    }

    let steps = 0;
    while (this.accumulator >= this.dt) {
      this.step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    this.lastStepCount = steps;

    this.render(this.accumulator / this.dt, frameMs / 1000);
  }

  /**
   * Deterministic advance for the harness. Never waits on vsync, never renders.
   * The numbers this produces are simulation truth and say nothing whatsoever
   * about frame rate — the performance suite uses the rAF samples instead.
   */
  advance(seconds: number, dt = this.dt): void {
    const steps = Math.max(0, Math.round(seconds / dt));
    for (let i = 0; i < steps; i++) this.step(dt);
  }

  /** p50 / p95 / worst frame times in ms, plus how many blew the budget. */
  frameStats(budgetMs = 1000 / 60): {
    samples: number;
    p50: number;
    p95: number;
    worst: number;
    overBudget: number;
    clampedFrames: number;
  } {
    const s = this.frameSamples.slice().sort((a, b) => a - b);
    if (!s.length) {
      return { samples: 0, p50: 0, p95: 0, worst: 0, overBudget: 0, clampedFrames: this.clampedFrames };
    }
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
    return {
      samples: s.length,
      p50: at(0.5),
      p95: at(0.95),
      worst: s[s.length - 1]!,
      overBudget: s.filter((v) => v > budgetMs).length,
      clampedFrames: this.clampedFrames,
    };
  }

  resetFrameStats(): void {
    this.frameSamples.length = 0;
    this.clampedFrames = 0;
    this.totalFrames = 0;
  }
}
