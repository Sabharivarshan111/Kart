import { CONFIG } from '../core/config.ts';
import { SurfaceKind } from '../core/contracts.ts';
import { clamp01 } from '../core/mathx.ts';
import { Rng } from '../core/rng.ts';

/**
 * All audio is synthesised — oscillators, filters and generated noise buffers.
 * No files, no fetches. The brief's zero-asset rule applies here as much as to
 * the meshes.
 *
 * The graph is built against a `BaseAudioContext` rather than an
 * `AudioContext`, which is what lets `selftest.ts` rebuild the identical graph
 * on an `OfflineAudioContext`, fire every cue, render it and measure the
 * result. Audio cannot be checked in a screenshot, so it is checked in
 * numbers — and those numbers prove each cue produces *signal*, not that it
 * sounds good. That distinction is honest and worth keeping.
 */

export type CueName =
  | 'engine'
  | 'scrub'
  | 'rumble-kerb'
  | 'rumble-grass'
  | 'rumble-sand'
  | 'impact-light'
  | 'impact-heavy'
  | 'drift-tier-1'
  | 'drift-tier-2'
  | 'drift-tier-3'
  | 'boost'
  | 'item-pickup'
  | 'item-fire'
  | 'item-hit'
  | 'lap'
  | 'countdown'
  | 'go'
  | 'crowd';

/** Deterministic noise, so the self-test's numbers are reproducible. */
function makeNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rng = new Rng(seed);
  for (let i = 0; i < length; i++) data[i] = rng.range(-1, 1);
  return buffer;
}

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  private readonly noise: AudioBuffer;

  // Continuous voices, started once and modulated.
  private readonly engineOscs: OscillatorNode[] = [];
  private readonly engineGains: GainNode[] = [];
  private readonly engineBus: GainNode;
  private readonly scrubSource: AudioBufferSourceNode;
  private readonly scrubFilter: BiquadFilterNode;
  private readonly scrubGain: GainNode;
  private readonly rumbleSource: AudioBufferSourceNode;
  private readonly rumbleFilter: BiquadFilterNode;
  private readonly rumbleGain: GainNode;
  private readonly crowdSource: AudioBufferSourceNode;
  private readonly crowdFilter: BiquadFilterNode;
  private readonly crowdGain: GainNode;

  private started = false;

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = CONFIG.audio.masterGain;
    this.master.connect(destination);

    this.noise = makeNoiseBuffer(ctx, 2.0, 0x51e4d);

    // --- engine ------------------------------------------------------------
    // Several harmonics rather than one oscillator: a single saw at 120 Hz is
    // a hum, and the harmonic stack is what makes it read as an engine.
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 2600;
    this.engineBus.connect(engineFilter);
    engineFilter.connect(this.master);

    for (let i = 0; i < CONFIG.audio.engineHarmonics.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'square';
      osc.frequency.value = CONFIG.audio.engineMinHz * CONFIG.audio.engineHarmonics[i]!;
      const gain = ctx.createGain();
      gain.gain.value = CONFIG.audio.engineHarmonicGains[i]!;
      osc.connect(gain);
      gain.connect(this.engineBus);
      this.engineOscs.push(osc);
      this.engineGains.push(gain);
    }

    // --- tyre scrub ---------------------------------------------------------
    this.scrubSource = ctx.createBufferSource();
    this.scrubSource.buffer = this.noise;
    this.scrubSource.loop = true;
    this.scrubFilter = ctx.createBiquadFilter();
    this.scrubFilter.type = 'bandpass';
    this.scrubFilter.frequency.value = 1800;
    this.scrubFilter.Q.value = 1.4;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.scrubSource.connect(this.scrubFilter);
    this.scrubFilter.connect(this.scrubGain);
    this.scrubGain.connect(this.master);

    // --- surface rumble -----------------------------------------------------
    this.rumbleSource = ctx.createBufferSource();
    this.rumbleSource.buffer = this.noise;
    this.rumbleSource.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 320;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSource.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);

    // --- crowd --------------------------------------------------------------
    this.crowdSource = ctx.createBufferSource();
    this.crowdSource.buffer = this.noise;
    this.crowdSource.loop = true;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 700;
    this.crowdFilter.Q.value = 0.6;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdSource.connect(this.crowdFilter);
    this.crowdFilter.connect(this.crowdGain);
    this.crowdGain.connect(this.master);
  }

  start(when = 0): void {
    if (this.started) return;
    this.started = true;
    for (const o of this.engineOscs) o.start(when);
    this.scrubSource.start(when);
    this.rumbleSource.start(when);
    this.crowdSource.start(when);
  }

  private get now(): number {
    return this.ctx.currentTime;
  }

  /**
   * @param rpmFraction 0..1 mapped across the engine's range.
   * @param load 0..1 — throttle. Off-throttle the engine drops in level but
   *   not in pitch, which is what makes lifting audible.
   */
  setEngine(rpmFraction: number, load: number, at = this.now): void {
    const f = clamp01(rpmFraction);
    const hz = CONFIG.audio.engineMinHz + (CONFIG.audio.engineMaxHz - CONFIG.audio.engineMinHz) * f;
    for (let i = 0; i < this.engineOscs.length; i++) {
      // setTargetAtTime rather than setValueAtTime: a stepped frequency at
      // 60 fps is audible as a stair, and the time constant smooths it without
      // needing a per-frame ramp schedule.
      this.engineOscs[i]!.frequency.setTargetAtTime(
        hz * CONFIG.audio.engineHarmonics[i]!,
        at,
        0.035,
      );
    }
    this.engineBus.gain.setTargetAtTime(0.16 + 0.2 * clamp01(load) + 0.1 * f, at, 0.05);
  }

  /** Tyre scrub rises with lateral slip. */
  setScrub(slipFraction: number, at = this.now): void {
    const s = clamp01(slipFraction);
    this.scrubGain.gain.setTargetAtTime(s * 0.30, at, 0.04);
    this.scrubFilter.frequency.setTargetAtTime(1200 + s * 2200, at, 0.06);
  }

  /** Surface-dependent rumble. Kerbs are the loudest and the brightest, which
   *  is how you hear that you have run wide before you see it. */
  setSurface(kind: SurfaceKind, speedFraction: number, at = this.now): void {
    const table: Record<number, { gain: number; hz: number }> = {
      [SurfaceKind.Road]: { gain: 0.03, hz: 240 },
      [SurfaceKind.Kerb]: { gain: 0.34, hz: 520 },
      [SurfaceKind.Grass]: { gain: 0.20, hz: 300 },
      [SurfaceKind.Sand]: { gain: 0.26, hz: 200 },
      [SurfaceKind.Boost]: { gain: 0.06, hz: 380 },
      [SurfaceKind.Void]: { gain: 0.22, hz: 180 },
    };
    const t = table[kind] ?? table[SurfaceKind.Road]!;
    this.rumbleGain.gain.setTargetAtTime(t.gain * clamp01(speedFraction), at, 0.05);
    this.rumbleFilter.frequency.setTargetAtTime(t.hz, at, 0.08);
  }

  setCrowd(level: number, at = this.now): void {
    this.crowdGain.gain.setTargetAtTime(clamp01(level) * 0.09, at, 0.4);
  }

  // --- one-shots -----------------------------------------------------------

  private burst(
    at: number,
    duration: number,
    peak: number,
    filterType: BiquadFilterType,
    startHz: number,
    endHz: number,
  ): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(startHz, at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), at + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(at);
    src.stop(at + duration + 0.02);
  }

  private tone(
    at: number,
    duration: number,
    peak: number,
    startHz: number,
    endHz: number,
    type: OscillatorType = 'square',
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(startHz, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), at + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  impact(strength: number, at = this.now): void {
    const s = clamp01(strength);
    this.burst(at, 0.14 + s * 0.2, 0.18 + s * 0.4, 'lowpass', 900 + s * 1800, 140);
  }

  /** Drift tier escalation. The player must be able to *hear* which tier they
   *  are on with their eyes on the corner exit — hence a rising pitch per tier
   *  rather than a louder version of the same sound. */
  driftTier(tier: number, at = this.now): void {
    const base = [0, 520, 700, 940][Math.min(3, Math.max(0, tier))]!;
    if (base === 0) return;
    this.tone(at, 0.16, 0.22, base, base * 1.5, 'triangle');
  }

  boost(at = this.now): void {
    this.burst(at, 0.5, 0.34, 'bandpass', 400, 3400);
    this.tone(at, 0.34, 0.16, 180, 620, 'sawtooth');
  }

  itemPickup(at = this.now): void {
    this.tone(at, 0.1, 0.2, 660, 990, 'square');
    this.tone(at + 0.1, 0.12, 0.18, 990, 1320, 'square');
  }

  itemFire(at = this.now): void {
    this.burst(at, 0.22, 0.3, 'highpass', 600, 2600);
  }

  itemHit(at = this.now): void {
    this.burst(at, 0.3, 0.42, 'lowpass', 2200, 160);
    this.tone(at, 0.24, 0.2, 340, 90, 'sawtooth');
  }

  lap(at = this.now): void {
    this.tone(at, 0.12, 0.22, 880, 880, 'triangle');
    this.tone(at + 0.13, 0.2, 0.24, 1320, 1320, 'triangle');
  }

  countdownBeep(final: boolean, at = this.now): void {
    this.tone(at, final ? 0.4 : 0.14, 0.3, final ? 880 : 440, final ? 880 : 440, 'square');
  }

  dispose(): void {
    try {
      for (const o of this.engineOscs) o.stop();
      this.scrubSource.stop();
      this.rumbleSource.stop();
      this.crowdSource.stop();
    } catch {
      // Already stopped, or never started. Neither matters at teardown.
    }
    this.master.disconnect();
  }
}
