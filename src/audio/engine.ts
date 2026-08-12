import { CONFIG } from '../core/config.ts';
import { SurfaceKind } from '../core/contracts.ts';
import { clamp01 } from '../core/mathx.ts';
import { Music, type CupThemeId } from './music.ts';
import { BHUPALI, ragaHz } from './raga.ts';
import { makeNoiseBuffer, makePluckBuffer, METAL_PARTIALS, pulseCurve } from './synth.ts';

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
 *
 * **Where the numbers live.** `CONFIG.audio` owns what crosses the module
 * boundary: master gain, the engine's Hz range and its harmonic mix. The per-cue
 * mix tables below stay here, because they are the sound design itself rather
 * than tunables any other module reads — moving a drift-tier partial ratio into
 * the global config would mean the config knows what an inharmonic partial is.
 * If a cue's level ever needs to be read by the HUD or the options screen, that
 * value moves to `CONFIG.audio` at that point and not before.
 *
 * ## Bus layout
 *
 * ```
 *   sfx ────────────────────────┐
 *   music ──▶ duck ─────────────┴──▶ master ──▶ destination
 * ```
 *
 * `duck` is what item cues and the finish fanfare pull down, so a cue is never
 * fighting the theme for the same 400 Hz.
 */

export type CueName =
  // continuous voices
  | 'engine-idle'
  | 'engine-accel'
  | 'engine-coast'
  | 'engine-lift'
  | 'scrub-tarmac'
  | 'scrub-gravel'
  | 'scrub-spray'
  | 'rumble-kerb'
  | 'rumble-grass'
  | 'rumble-sand'
  | 'kerb-rattle-slow'
  | 'kerb-rattle-fast'
  | 'crowd'
  | 'crowd-cheer'
  // one-shots
  | 'impact-light'
  | 'impact-heavy'
  | 'drift-hop'
  | 'drift-tier-1'
  | 'drift-tier-2'
  | 'drift-tier-3'
  | 'boost'
  | 'spin-out'
  | 'respawn'
  | 'item-box'
  | 'item-pickup'
  | 'item-fire'
  | 'item-hit'
  | 'lap'
  | 'countdown'
  | 'go'
  | 'finish-fanfare'
  // music
  | 'music-copper'
  | 'music-lantern';

/** How the tyre sounds on each surface. Three timbres, not three volumes:
 *  a tarmac squeal, a gravel grind and a spray/wash, crossfaded per surface.
 *
 *  There is no water surface in `SurfaceKind` — the enum is owned by
 *  `core/contracts.ts` and adding one is a track-and-physics change, not an
 *  audio change — so `Void` (off the corridor entirely, before respawn takes
 *  over) carries the spray timbre. On a backwater track that is the puddle
 *  edge; on a desert one it is dust wash. It is a stand-in and it is labelled
 *  as one. */
const SCRUB_TIMBRE: Record<number, { squeal: number; grind: number; spray: number }> = {
  [SurfaceKind.Road]: { squeal: 1.0, grind: 0.08, spray: 0.05 },
  [SurfaceKind.Kerb]: { squeal: 0.85, grind: 0.35, spray: 0.05 },
  [SurfaceKind.Boost]: { squeal: 1.0, grind: 0.08, spray: 0.05 },
  [SurfaceKind.Grass]: { squeal: 0.10, grind: 0.55, spray: 0.5 },
  [SurfaceKind.Sand]: { squeal: 0.05, grind: 1.0, spray: 0.18 },
  [SurfaceKind.Void]: { squeal: 0.05, grind: 0.45, spray: 1.0 },
};

/** Surface rumble bed: level and where its energy sits. */
const RUMBLE: Record<number, { gain: number; hz: number }> = {
  [SurfaceKind.Road]: { gain: 0.03, hz: 240 },
  [SurfaceKind.Kerb]: { gain: 0.20, hz: 520 },
  [SurfaceKind.Grass]: { gain: 0.20, hz: 300 },
  [SurfaceKind.Sand]: { gain: 0.26, hz: 200 },
  [SurfaceKind.Boost]: { gain: 0.06, hz: 380 },
  [SurfaceKind.Void]: { gain: 0.22, hz: 180 },
};

/** Metres between kerb ribs. Sets the rattle rate: at 24.5 m/s the rattle is
 *  27 Hz and fuses into a buzz, at 5 m/s it is 5.5 separate knocks a second,
 *  which is exactly how a kerb behaves. Shrink it and the rattle is a tone at
 *  any speed, which is the "louder hiss" failure this replaced. */
const KERB_RIB_SPACING = 0.9;

/** Drift-tier pitches, as degrees of Bhupali on Sa = C5 (see raga.ts): the
 *  escalation is a phrase in the same scale the music is in, so it lands as
 *  part of the score rather than as a system beep.
 *  Tier 1 Ga; tier 2 Pa→Dha; tier 3 Dha→Sa'→Ga'. */
const DRIFT_SA = 261.63; // C4 as the reference Sa for cue material.

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly sfx: GainNode;
  /** Music passes through here so cues can duck it. */
  readonly musicDuck: GainNode;

  music: Music | null = null;

  private readonly noiseEngine: AudioBuffer;
  private readonly noiseTyre: AudioBuffer;
  private readonly noiseAmbient: AudioBuffer;
  /** A few plucked strings for the jingles. Built once; playing one allocates
   *  a source and a gain and nothing else. */
  private readonly cueBank: AudioBuffer[] = [];

  // --- continuous voices ---------------------------------------------------
  private readonly engineOscs: OscillatorNode[] = [];
  private readonly engineGains: GainNode[] = [];
  private readonly engineBus: GainNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly intakeSource: AudioBufferSourceNode;
  private readonly intakeFilter: BiquadFilterNode;
  private readonly intakeGain: GainNode;
  private readonly overrunSource: AudioBufferSourceNode;
  private readonly overrunFilter: BiquadFilterNode;
  private readonly overrunGain: GainNode;
  private readonly burbleLfo: OscillatorNode;
  private readonly burbleDepth: GainNode;

  private readonly scrubSource: AudioBufferSourceNode;
  private readonly scrubBus: GainNode;
  private readonly squealFilter: BiquadFilterNode;
  private readonly squealGain: GainNode;
  private readonly squealTone: OscillatorNode;
  private readonly squealToneGain: GainNode;
  private readonly grindFilter: BiquadFilterNode;
  private readonly grindGain: GainNode;
  private readonly grindLfo: OscillatorNode;
  private readonly grindDepth: GainNode;
  private readonly sprayFilter: BiquadFilterNode;
  private readonly sprayGain: GainNode;

  private readonly rumbleSource: AudioBufferSourceNode;
  private readonly rumbleFilter: BiquadFilterNode;
  private readonly rumbleGain: GainNode;
  private readonly rattleSource: AudioBufferSourceNode;
  private readonly rattleFilter: BiquadFilterNode;
  private readonly rattleGain: GainNode;
  private readonly rattleLfo: OscillatorNode;
  private readonly rattleDepth: GainNode;

  private readonly crowdSource: AudioBufferSourceNode;
  private readonly crowdFilter: BiquadFilterNode;
  private readonly crowdGain: GainNode;
  private readonly crowdLfo: OscillatorNode;
  private readonly crowdDepth: GainNode;

  private started = false;
  /** Previous throttle, so a lift can be detected as an *edge*. Reading the
   *  level alone cannot tell "coasting" from "just lifted", and the lift is the
   *  half of it a driver actually hears. */
  private lastLoad = 0;
  private lastRpm = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = CONFIG.audio.masterGain;
    this.master.connect(destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);

    this.musicDuck = ctx.createGain();
    this.musicDuck.gain.value = 1;
    this.musicDuck.connect(this.master);

    // Three uncorrelated noise beds at different lengths. One shared buffer
    // across every voice sums coherently — the loop points line up and you hear
    // a periodic swish at 1/length Hz across the whole mix.
    this.noiseEngine = makeNoiseBuffer(ctx, 2.3, 0x51e4d);
    this.noiseTyre = makeNoiseBuffer(ctx, 2.7, 0x1c0ffee);
    this.noiseAmbient = makeNoiseBuffer(ctx, 3.1, 0x7a1105);

    for (let d = 0; d < 6; d++) {
      this.cueBank.push(makePluckBuffer(ctx, ragaHz(BHUPALI, DRIFT_SA * 2, d), 1.1, 1.4, 0x2b17 + d * 97, 0.75));
    }

    // --- engine ------------------------------------------------------------
    // Several harmonics rather than one oscillator: a single saw at 120 Hz is
    // a hum, and the harmonic stack is what makes it read as an engine. The
    // upper harmonics are then *gated by throttle*, which is the difference
    // between accelerating and coasting at the same road speed — an engine
    // under load is bright, an engine on the overrun is dark.
    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 0.9;
    this.engineBus.connect(this.engineFilter);
    this.engineFilter.connect(this.sfx);

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

    // Intake roar: on-throttle only, and it tracks rpm so it reads as air being
    // pulled rather than as a hiss laid over the top.
    this.intakeSource = ctx.createBufferSource();
    this.intakeSource.buffer = this.noiseEngine;
    this.intakeSource.loop = true;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.frequency.value = 900;
    this.intakeFilter.Q.value = 0.7;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeSource.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(this.sfx);

    // Overrun burble: off-throttle only, amplitude-modulated at a rate that
    // tracks rpm so it pops and crackles like a closed throttle rather than
    // just going quiet.
    this.overrunSource = ctx.createBufferSource();
    this.overrunSource.buffer = this.noiseEngine;
    this.overrunSource.loop = true;
    this.overrunFilter = ctx.createBiquadFilter();
    this.overrunFilter.type = 'bandpass';
    this.overrunFilter.frequency.value = 340;
    this.overrunFilter.Q.value = 4.0;
    this.overrunGain = ctx.createGain();
    this.overrunGain.gain.value = 0;
    this.overrunSource.connect(this.overrunFilter);
    this.overrunFilter.connect(this.overrunGain);
    this.overrunGain.connect(this.sfx);

    this.burbleLfo = ctx.createOscillator();
    this.burbleLfo.type = 'sine';
    this.burbleLfo.frequency.value = 14;
    const burbleShaper = ctx.createWaveShaper();
    burbleShaper.curve = pulseCurve(3);
    this.burbleDepth = ctx.createGain();
    this.burbleDepth.gain.value = 0;
    this.burbleLfo.connect(burbleShaper);
    burbleShaper.connect(this.burbleDepth);
    this.burbleDepth.connect(this.overrunGain.gain);

    // --- tyre scrub ---------------------------------------------------------
    // One noise source into three parallel timbres, crossfaded by surface.
    this.scrubSource = ctx.createBufferSource();
    this.scrubSource.buffer = this.noiseTyre;
    this.scrubSource.loop = true;
    this.scrubBus = ctx.createGain();
    this.scrubBus.gain.value = 0;
    this.scrubBus.connect(this.sfx);

    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1600;
    // Q 6, not 1.4: a low-Q band is a hiss. The narrow band is the squeal.
    this.squealFilter.Q.value = 6;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.scrubSource.connect(this.squealFilter);
    this.squealFilter.connect(this.squealGain);
    this.squealGain.connect(this.scrubBus);

    // A pitched partial on top of the filtered noise. Real tyre squeal has a
    // tone in it — stick-slip is periodic — and noise alone never gets there.
    this.squealTone = ctx.createOscillator();
    this.squealTone.type = 'triangle';
    this.squealTone.frequency.value = 1200;
    this.squealToneGain = ctx.createGain();
    this.squealToneGain.gain.value = 0;
    this.squealTone.connect(this.squealToneGain);
    this.squealToneGain.connect(this.scrubBus);

    this.grindFilter = ctx.createBiquadFilter();
    this.grindFilter.type = 'lowpass';
    this.grindFilter.frequency.value = 420;
    this.grindFilter.Q.value = 1.2;
    this.grindGain = ctx.createGain();
    this.grindGain.gain.value = 0;
    this.scrubSource.connect(this.grindFilter);
    this.grindFilter.connect(this.grindGain);
    this.grindGain.connect(this.scrubBus);
    // Granularity: gravel is discrete stones, so the grind is chopped rather
    // than smooth.
    this.grindLfo = ctx.createOscillator();
    this.grindLfo.type = 'sine';
    this.grindLfo.frequency.value = 38;
    const grindShaper = ctx.createWaveShaper();
    grindShaper.curve = pulseCurve(2);
    this.grindDepth = ctx.createGain();
    this.grindDepth.gain.value = 0;
    this.grindLfo.connect(grindShaper);
    grindShaper.connect(this.grindDepth);
    this.grindDepth.connect(this.grindGain.gain);

    this.sprayFilter = ctx.createBiquadFilter();
    this.sprayFilter.type = 'highpass';
    this.sprayFilter.frequency.value = 2600;
    this.sprayFilter.Q.value = 0.6;
    this.sprayGain = ctx.createGain();
    this.sprayGain.gain.value = 0;
    this.scrubSource.connect(this.sprayFilter);
    this.sprayFilter.connect(this.sprayGain);
    this.sprayGain.connect(this.scrubBus);

    // --- surface rumble -----------------------------------------------------
    this.rumbleSource = ctx.createBufferSource();
    this.rumbleSource.buffer = this.noiseAmbient;
    this.rumbleSource.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 320;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSource.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.sfx);

    // --- kerb rattle --------------------------------------------------------
    // A periodic knock whose rate is road speed / rib spacing. The LFO is
    // waveshaped into narrow pulses first: a sine used as a modulator gives a
    // smooth wobble, which reads as a tremolo pedal and not as a kerb.
    this.rattleSource = ctx.createBufferSource();
    this.rattleSource.buffer = this.noiseAmbient;
    this.rattleSource.loop = true;
    this.rattleFilter = ctx.createBiquadFilter();
    this.rattleFilter.type = 'bandpass';
    this.rattleFilter.frequency.value = 1200;
    this.rattleFilter.Q.value = 1.1;
    this.rattleGain = ctx.createGain();
    this.rattleGain.gain.value = 0;
    this.rattleSource.connect(this.rattleFilter);
    this.rattleFilter.connect(this.rattleGain);
    this.rattleGain.connect(this.sfx);

    this.rattleLfo = ctx.createOscillator();
    this.rattleLfo.type = 'sine';
    this.rattleLfo.frequency.value = 8;
    const rattleShaper = ctx.createWaveShaper();
    rattleShaper.curve = pulseCurve(6);
    this.rattleDepth = ctx.createGain();
    this.rattleDepth.gain.value = 0;
    this.rattleLfo.connect(rattleShaper);
    rattleShaper.connect(this.rattleDepth);
    this.rattleDepth.connect(this.rattleGain.gain);

    // --- crowd --------------------------------------------------------------
    this.crowdSource = ctx.createBufferSource();
    this.crowdSource.buffer = this.noiseAmbient;
    this.crowdSource.loop = true;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 700;
    this.crowdFilter.Q.value = 0.6;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    this.crowdSource.connect(this.crowdFilter);
    this.crowdFilter.connect(this.crowdGain);
    this.crowdGain.connect(this.sfx);
    // A crowd breathes. A static band of noise is air conditioning.
    this.crowdLfo = ctx.createOscillator();
    this.crowdLfo.type = 'sine';
    this.crowdLfo.frequency.value = 0.11;
    this.crowdDepth = ctx.createGain();
    this.crowdDepth.gain.value = 0;
    this.crowdLfo.connect(this.crowdDepth);
    this.crowdDepth.connect(this.crowdGain.gain);
  }

  start(when = 0): void {
    if (this.started) return;
    this.started = true;
    for (const o of this.engineOscs) o.start(when);
    this.intakeSource.start(when);
    this.overrunSource.start(when);
    this.burbleLfo.start(when);
    this.scrubSource.start(when);
    this.squealTone.start(when);
    this.grindLfo.start(when);
    this.rumbleSource.start(when);
    this.rattleSource.start(when);
    this.rattleLfo.start(when);
    this.crowdSource.start(when);
    this.crowdLfo.start(when);
  }

  private get now(): number {
    return this.ctx.currentTime;
  }

  // =========================================================================
  //  Music
  // =========================================================================

  /** Build and start a cup theme. Safe to call again with the same id — the
   *  second call is ignored rather than starting a second copy over the top. */
  startMusic(theme: CupThemeId, when = this.now, level = 1): Music {
    if (this.music && this.music.theme.id === theme) return this.music;
    this.music?.stop();
    this.music = new Music(this.ctx, this.musicDuck, theme);
    this.music.start(when, 1.2, level);
    return this.music;
  }

  stopMusic(): void {
    this.music?.stop();
    this.music = null;
  }

  setMusicLevel(level: number, at = this.now): void {
    this.music?.setLevel(level, at);
  }

  /**
   * Pull the music down under a cue.
   *
   * `setTargetAtTime` toward the floor, hold, then a linear recovery: the
   * cancel-and-hold is what stops two overlapping ducks from fighting, which
   * otherwise leaves the music stuck quiet after a busy item exchange.
   */
  duck(depth: number, hold: number, at = this.now): void {
    const g = this.musicDuck.gain;
    const floor = clamp01(1 - depth);
    g.cancelScheduledValues(at);
    g.setTargetAtTime(floor, at, 0.02);
    g.setValueAtTime(floor, at + hold);
    g.linearRampToValueAtTime(1, at + hold + 0.35);
  }

  // =========================================================================
  //  Continuous voices
  // =========================================================================

  /**
   * @param rpmFraction 0..1 mapped across the engine's range.
   * @param load        0..1 — throttle.
   *
   * Three things change with load, not one:
   *  1. **Level.** Off-throttle drops the bus by roughly a third.
   *  2. **Brightness.** The lowpass opens from 900 Hz to ~3.5 kHz with throttle
   *     and rpm, and the upper harmonics are gated too — that is what makes
   *     accelerating and coasting at the same road speed different *sounds*
   *     rather than the same sound at two volumes.
   *  3. **Character.** On throttle, intake roar. Off throttle, an overrun
   *     burble whose pop rate tracks rpm.
   *
   * Lifting is additionally an *edge*: a fast drop in throttle at speed fires a
   * one-shot decel pop, because the moment of lifting is the part a driver uses
   * to place the kart and a smooth crossfade throws it away.
   */
  setEngine(rpmFraction: number, load: number, at = this.now): void {
    const f = clamp01(rpmFraction);
    const l = clamp01(load);
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
      const base = CONFIG.audio.engineHarmonicGains[i]!;
      // Harmonic i>0 is scaled 0.40..1.0 by throttle. The fundamental is not,
      // so lifting thins the tone instead of removing the engine.
      const gate = i === 0 ? 1 : 0.40 + 0.60 * l;
      this.engineGains[i]!.gain.setTargetAtTime(base * gate, at, 0.05);
    }

    this.engineBus.gain.setTargetAtTime(0.11 + 0.20 * l + 0.09 * f, at, 0.05);
    this.engineFilter.frequency.setTargetAtTime(700 + 1900 * l + 1100 * f, at, 0.06);

    this.intakeGain.gain.setTargetAtTime(0.085 * l * (0.25 + 0.75 * f), at, 0.06);

    // Overrun only exists off-throttle and only above idle: an engine coasting
    // at walking pace has nothing to burble with.
    const overrun = (1 - l) * f * f;
    this.overrunGain.gain.setTargetAtTime(0.045 * overrun, at, 0.07);
    this.burbleDepth.gain.setTargetAtTime(0.075 * overrun, at, 0.07);
    this.burbleLfo.frequency.setTargetAtTime(11 + 30 * f, at, 0.08);

    // The lift edge. 0.28 chosen so a modulated throttle mid-corner does not
    // fire it every frame; a real lift crosses it in one update.
    if (this.lastLoad - l > 0.28 && f > 0.30) this.engineLift(f, at);
    this.lastLoad = l;
    this.lastRpm = f;
  }

  /** The pop and blip of a closed throttle. Fired from `setEngine` on the
   *  lift edge, and separately testable. */
  engineLift(rpmFraction = this.lastRpm, at = this.now): void {
    const f = clamp01(rpmFraction);
    this.overrunGain.gain.setValueAtTime(0.045 * f + 0.11, at);
    this.overrunGain.gain.setTargetAtTime(0.045 * (1 - this.lastLoad) * f * f, at + 0.02, 0.12);
    this.noiseHit(at, 0.16, 0.13 + 0.10 * f, 'bandpass', 320 + 500 * f, 180, 3.2);
    this.oscHit(at, 0.20, 0.07 + 0.05 * f, 'sawtooth', CONFIG.audio.engineMaxHz * f * 1.5 + 60, 70);
  }

  /**
   * Tyre scrub. Rises with lateral slip and changes *timbre* with the surface:
   * a narrow-band squeal on tarmac, a chopped low grind on sand, a bright wash
   * on grass and off-corridor.
   */
  setScrub(slipFraction: number, surface: SurfaceKind = SurfaceKind.Road, at = this.now): void {
    const s = clamp01(slipFraction);
    const t = SCRUB_TIMBRE[surface] ?? SCRUB_TIMBRE[SurfaceKind.Road]!;
    // Slightly superlinear: a tyre is quiet until it is genuinely sliding, and
    // a linear map makes every corner sound like a drift.
    const level = s * s * 0.62 + s * 0.10;

    this.scrubBus.gain.setTargetAtTime(level * 0.42, at, 0.04);
    this.squealGain.gain.setTargetAtTime(t.squeal, at, 0.05);
    this.grindGain.gain.setTargetAtTime(t.grind * 0.75, at, 0.05);
    this.sprayGain.gain.setTargetAtTime(t.spray * 0.55, at, 0.05);

    this.squealFilter.frequency.setTargetAtTime(1100 + s * 2400, at, 0.06);
    this.squealToneGain.gain.setTargetAtTime(t.squeal * s * s * 0.16, at, 0.05);
    this.squealTone.frequency.setTargetAtTime(900 + s * 1500, at, 0.07);

    this.grindFilter.frequency.setTargetAtTime(260 + s * 520, at, 0.06);
    this.grindDepth.gain.setTargetAtTime(t.grind * 0.55, at, 0.06);
    this.grindLfo.frequency.setTargetAtTime(26 + s * 70, at, 0.08);

    this.sprayFilter.frequency.setTargetAtTime(2200 + s * 1800, at, 0.06);
  }

  /**
   * Surface rumble plus, on a kerb, the rattle.
   *
   * @param speedFraction road speed as a fraction of base top speed. The rattle
   *   rate is derived from it and the rib spacing, so the kerb speeds up with
   *   you — that periodicity is the whole cue, and a louder hiss is not it.
   */
  setSurface(kind: SurfaceKind, speedFraction: number, at = this.now): void {
    const v = clamp01(speedFraction);
    const t = RUMBLE[kind] ?? RUMBLE[SurfaceKind.Road]!;
    this.rumbleGain.gain.setTargetAtTime(t.gain * v, at, 0.05);
    this.rumbleFilter.frequency.setTargetAtTime(t.hz, at, 0.08);

    const onKerb = kind === SurfaceKind.Kerb ? 1 : 0;
    const ribHz = (v * CONFIG.kart.topSpeed) / KERB_RIB_SPACING;
    // Floor of 3 Hz so a kart stopped on a kerb does not schedule a DC ramp on
    // the LFO; the depth is zero there anyway.
    this.rattleLfo.frequency.setTargetAtTime(Math.max(3, ribHz), at, 0.05);
    this.rattleDepth.gain.setTargetAtTime(onKerb * (0.06 + 0.20 * v), at, 0.04);
    this.rattleFilter.frequency.setTargetAtTime(700 + 900 * v, at, 0.06);
  }

  setCrowd(level: number, at = this.now): void {
    const l = clamp01(level);
    this.crowdGain.gain.setTargetAtTime(l * 0.07, at, 0.4);
    this.crowdDepth.gain.setTargetAtTime(l * 0.045, at, 0.4);
    this.crowdFilter.frequency.setTargetAtTime(560 + 420 * l, at, 0.5);
  }

  /** A swell of cheering. Fired on an overtake, a lap or the finish. */
  crowdCheer(intensity = 1, at = this.now): void {
    const i = clamp01(intensity);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseAmbient;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(700, at);
    f.frequency.linearRampToValueAtTime(1500, at + 0.35);
    f.frequency.linearRampToValueAtTime(800, at + 1.6);
    f.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.14 * i, at + 0.3);
    g.gain.setValueAtTime(0.14 * i, at + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.7);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfx);
    src.start(at);
    src.stop(at + 1.75);
  }

  // =========================================================================
  //  One-shot primitives
  // =========================================================================

  private noiseHit(
    at: number,
    duration: number,
    peak: number,
    filterType: BiquadFilterType,
    startHz: number,
    endHz: number,
    q = 1,
    dest: AudioNode = this.sfx,
    attack = 0.004,
    buffer: AudioBuffer = this.noiseEngine,
  ): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(20, startHz), at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), at + duration);
    const gain = this.ctx.createGain();
    // Linear attack from true zero. An exponential ramp from 0.0001 puts the
    // audible onset several milliseconds late, which the sequencer drift test
    // would then have to subtract back out.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start(at);
    src.stop(at + duration + 0.02);
  }

  private oscHit(
    at: number,
    duration: number,
    peak: number,
    type: OscillatorType,
    startHz: number,
    endHz: number,
    dest: AudioNode = this.sfx,
    attack = 0.006,
    detune = 0,
  ): OscillatorNode {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(Math.max(20, startHz), at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endHz), at + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + duration + 0.02);
    return osc;
  }

  /** Struck metal: inharmonic partials, because integer harmonics are exactly
   *  why a naive clang sounds like an organ chord. */
  private metalHit(at: number, duration: number, peak: number, baseHz: number): void {
    for (let i = 0; i < METAL_PARTIALS.length; i++) {
      const ratio = METAL_PARTIALS[i]!;
      // Higher partials die first, as they do on a real plate.
      const d = duration * (1 - i * 0.14);
      this.oscHit(at, Math.max(0.04, d), peak * Math.pow(0.62, i), 'sine', baseHz * ratio, baseHz * ratio * 0.98, this.sfx, 0.002);
    }
  }

  /** One note of the plucked-string cue bank. */
  private pluck(at: number, degree: number, peak: number, seconds = 0.7): void {
    const buffer = this.cueBank[Math.min(this.cueBank.length - 1, Math.max(0, degree))];
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.003);
    g.gain.setTargetAtTime(0.0001, at + seconds * 0.5, seconds * 0.3);
    src.connect(g);
    g.connect(this.sfx);
    src.start(at);
    src.stop(at + Math.min(buffer.duration, seconds + 0.4));
  }

  /** A short flute-ish tone, for the lap and fanfare figures. */
  private blow(at: number, hz: number, seconds: number, peak: number, fromHz?: number): void {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + Math.min(0.05, seconds * 0.25));
    g.gain.setValueAtTime(peak, at + seconds * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    g.connect(this.sfx);
    for (const [mult, level] of [[1, 1], [2, 0.16]] as [number, number][]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      if (fromHz !== undefined) {
        osc.frequency.setValueAtTime(fromHz * mult, at);
        osc.frequency.exponentialRampToValueAtTime(hz * mult, at + Math.min(0.14, seconds * 0.4));
      } else {
        osc.frequency.setValueAtTime(hz * mult, at);
      }
      const lg = this.ctx.createGain();
      lg.gain.value = level;
      osc.connect(lg);
      lg.connect(g);
      osc.start(at);
      osc.stop(at + seconds + 0.03);
    }
    this.noiseHit(at, Math.min(0.12, seconds), peak * 0.35, 'bandpass', hz * 1.8, hz * 1.6, 1.8, g, 0.008, this.noiseAmbient);
  }

  // =========================================================================
  //  Cues
  // =========================================================================

  /**
   * A wall or a kart. Three layers, because a single filtered burst is a
   * "pff": a low body thump you feel, the panel clang, and debris for a big
   * one.
   */
  impact(strength: number, at = this.now): void {
    const s = clamp01(strength);
    this.oscHit(at, 0.12 + 0.16 * s, 0.22 + 0.34 * s, 'sine', 190 + 90 * s, 48, this.sfx, 0.002);
    this.noiseHit(at, 0.10 + 0.16 * s, 0.16 + 0.30 * s, 'lowpass', 1100 + 1900 * s, 180, 0.9);
    this.metalHit(at + 0.004, 0.16 + 0.22 * s, 0.06 + 0.16 * s, 210 + 120 * s);
    if (s > 0.5) {
      // Debris: three ticks, deterministically placed so the self-test's
      // numbers repeat.
      for (let i = 0; i < 3; i++) {
        this.noiseHit(at + 0.06 + i * 0.045, 0.05, 0.05 * s, 'bandpass', 3200 - i * 500, 2400, 3);
      }
    }
  }

  /** The drift hop. A tick and a body knock — this is the tell that the state
   *  changed, and it is deliberately *not* one of the tier sounds. */
  driftHop(at = this.now): void {
    this.noiseHit(at, 0.09, 0.20, 'bandpass', 2400, 900, 2.2);
    this.oscHit(at, 0.10, 0.13, 'sine', 240, 130, this.sfx, 0.002);
  }

  /**
   * Drift tier escalation.
   *
   * The player has to hear which tier they are on with their eyes on the corner
   * exit, so the three are different in **pitch and in timbre**, not in volume:
   *
   *  - **1** a single soft triangle blip on Ga, with a tick.
   *  - **2** a two-note rise Pa→Dha on a detuned pair through a resonant band —
   *    obviously a *pair* of notes, and obviously reedier than tier 1.
   *  - **3** a three-note arpeggio Dha→Sa'→Ga' on an FM bell, over a noise
   *    riser and a sub thump. Bell, riser and sub are all absent from the other
   *    two tiers.
   */
  driftTier(tier: number, at = this.now): void {
    const t = Math.min(3, Math.max(0, Math.round(tier)));
    if (t === 0) return;
    const hz = (degree: number) => ragaHz(BHUPALI, DRIFT_SA * 2, degree);

    if (t === 1) {
      this.oscHit(at, 0.16, 0.20, 'triangle', hz(2), hz(2) * 1.5, this.sfx, 0.004);
      this.noiseHit(at, 0.07, 0.10, 'bandpass', 3000, 2000, 3);
      return;
    }

    if (t === 2) {
      for (const [i, degree] of [3, 4].entries()) {
        const start = at + i * 0.085;
        // A detuned pair through a band: reedy, and audibly two notes.
        for (const detune of [-7, 7]) {
          const osc = this.ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.detune.value = detune;
          osc.frequency.setValueAtTime(hz(degree), start);
          const band = this.ctx.createBiquadFilter();
          band.type = 'bandpass';
          band.frequency.setValueAtTime(hz(degree) * 2, start);
          band.frequency.exponentialRampToValueAtTime(hz(degree) * 3.4, start + 0.16);
          band.Q.value = 3;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0, start);
          g.gain.linearRampToValueAtTime(0.14, start + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, start + 0.20);
          osc.connect(band);
          band.connect(g);
          g.connect(this.sfx);
          osc.start(start);
          osc.stop(start + 0.22);
        }
      }
      return;
    }

    // Tier 3.
    for (const [i, degree] of [4, 5, 7].entries()) {
      const start = at + i * 0.075;
      const carrierHz = hz(degree);
      // FM bell: a modulator at a non-integer ratio is what makes it a bell
      // rather than a brighter beep.
      const mod = this.ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = carrierHz * 1.41;
      const modDepth = this.ctx.createGain();
      modDepth.gain.setValueAtTime(carrierHz * 1.6, start);
      modDepth.gain.exponentialRampToValueAtTime(carrierHz * 0.05, start + 0.28);
      mod.connect(modDepth);
      const carrier = this.ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = carrierHz;
      modDepth.connect(carrier.frequency);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.20, start + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      carrier.connect(g);
      g.connect(this.sfx);
      mod.start(start);
      mod.stop(start + 0.45);
      carrier.start(start);
      carrier.stop(start + 0.45);
    }
    this.noiseHit(at, 0.34, 0.14, 'bandpass', 700, 5200, 1.4);
    this.oscHit(at, 0.30, 0.16, 'sine', 96, 62, this.sfx, 0.004);
  }

  /**
   * Boost. A doppler-ish sweep: the band and the tone both rise as it comes at
   * you and fall as it passes, which is why the sweep is up-then-down rather
   * than the usual monotonic riser.
   */
  boost(at = this.now): void {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseTyre;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.8;
    band.frequency.setValueAtTime(320, at);
    band.frequency.exponentialRampToValueAtTime(3200, at + 0.20);
    band.frequency.exponentialRampToValueAtTime(700, at + 0.62);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.34, at + 0.09);
    g.gain.setValueAtTime(0.34, at + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.62);
    src.connect(band);
    band.connect(g);
    g.connect(this.sfx);
    src.start(at);
    src.stop(at + 0.65);

    // The pitched part of the doppler: approach, pass, recede.
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, at);
    osc.frequency.exponentialRampToValueAtTime(560, at + 0.18);
    osc.frequency.exponentialRampToValueAtTime(300, at + 0.55);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0, at);
    og.gain.linearRampToValueAtTime(0.15, at + 0.05);
    og.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    osc.connect(lp);
    lp.connect(og);
    og.connect(this.sfx);
    osc.start(at);
    osc.stop(at + 0.58);

    // The shove in the back.
    this.oscHit(at, 0.16, 0.20, 'sine', 130, 55, this.sfx, 0.002);
  }

  /** Spin-out: a detuned wobble falling away, plus the tyres letting go. */
  spinOut(at = this.now): void {
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(11, at);
    lfo.frequency.exponentialRampToValueAtTime(4, at + 0.9);
    const depth = this.ctx.createGain();
    depth.gain.setValueAtTime(90, at);
    depth.gain.exponentialRampToValueAtTime(14, at + 0.9);
    lfo.connect(depth);
    lfo.start(at);
    lfo.stop(at + 0.95);

    for (const detune of [-14, 12]) {
      const osc = this.oscHit(at, 0.9, 0.12, 'sawtooth', 430, 105, this.sfx, 0.01, detune);
      depth.connect(osc.frequency);
    }
    this.noiseHit(at, 0.7, 0.16, 'bandpass', 1900, 500, 2.4, this.sfx, 0.02, this.noiseTyre);
    this.oscHit(at, 0.20, 0.16, 'sine', 150, 60, this.sfx, 0.002);
  }

  /** Respawn: a descending shimmer that pulls you out, then a soft set-down. */
  respawn(at = this.now): void {
    for (const [i, detune] of [-9, 0, 11].entries()) {
      this.oscHit(at + i * 0.02, 0.42, 0.09, 'triangle', 1500, 320, this.sfx, 0.01, detune);
    }
    this.noiseHit(at, 0.40, 0.10, 'highpass', 4200, 900, 0.7, this.sfx, 0.02, this.noiseAmbient);
    // The set-down, after the shimmer has fallen.
    this.oscHit(at + 0.40, 0.22, 0.18, 'sine', 190, 70, this.sfx, 0.003);
    this.noiseHit(at + 0.40, 0.16, 0.10, 'lowpass', 900, 200, 0.9);
    this.pluck(at + 0.44, 3, 0.16, 0.6);
  }

  /**
   * Hitting an item box: the roulette starts. A four-note rising pluck figure
   * on the raga's own degrees, which is the jingle; the settle is `itemPickup`.
   * Ducks the music so the jingle is heard over the theme.
   */
  itemBox(at = this.now): void {
    this.duck(0.4, 0.35, at);
    const degrees = [0, 2, 3, 4];
    for (let i = 0; i < degrees.length; i++) {
      this.pluck(at + i * 0.06, degrees[i]!, 0.22, 0.5);
    }
    this.noiseHit(at, 0.10, 0.10, 'highpass', 3200, 5200, 0.8);
  }

  /** The roulette settling on an item. Two notes, up, and a soft confirm. */
  itemPickup(at = this.now): void {
    this.duck(0.35, 0.25, at);
    this.pluck(at, 3, 0.30, 0.45);
    this.pluck(at + 0.11, 5, 0.34, 0.7);
    this.blow(at + 0.11, ragaHz(BHUPALI, DRIFT_SA * 2, 5), 0.30, 0.10);
  }

  /** Throwing something. */
  itemFire(at = this.now): void {
    this.duck(0.3, 0.2, at);
    this.noiseHit(at, 0.26, 0.28, 'bandpass', 700, 3600, 1.6, this.sfx, 0.006, this.noiseTyre);
    this.oscHit(at, 0.18, 0.10, 'square', 420, 1500, this.sfx, 0.004);
  }

  /** Being hit by something. */
  itemHit(at = this.now): void {
    this.duck(0.5, 0.35, at);
    this.oscHit(at, 0.30, 0.34, 'sine', 260, 52, this.sfx, 0.002);
    this.noiseHit(at, 0.34, 0.30, 'lowpass', 2600, 160, 0.9);
    this.metalHit(at + 0.01, 0.26, 0.13, 170);
    this.oscHit(at + 0.02, 0.26, 0.14, 'sawtooth', 380, 90, this.sfx, 0.004);
  }

  /** Crossing the line. A two-note bansuri figure with a glide into the
   *  second, so it reads as the same instrument the theme uses. */
  lap(at = this.now): void {
    const hz = (d: number) => ragaHz(BHUPALI, DRIFT_SA * 2, d);
    this.blow(at, hz(3), 0.18, 0.20);
    this.blow(at + 0.16, hz(5), 0.34, 0.24, hz(4));
    this.pluck(at + 0.16, 5, 0.20, 0.5);
  }

  /** Countdown. The three are a damped stroke; GO is the open one plus the
   *  crowd, so the start is unmistakable without reading the HUD. */
  countdownBeep(final: boolean, at = this.now): void {
    if (!final) {
      this.noiseHit(at, 0.09, 0.16, 'bandpass', 2600, 1800, 2.0);
      this.oscHit(at, 0.16, 0.16, 'sine', 520, 500, this.sfx, 0.002);
      return;
    }
    this.oscHit(at, 0.42, 0.30, 'sine', 300, 96, this.sfx, 0.002);
    this.noiseHit(at, 0.22, 0.22, 'bandpass', 2000, 900, 1.2);
    this.blow(at + 0.02, ragaHz(BHUPALI, DRIFT_SA * 2, 5), 0.42, 0.22);
    this.crowdCheer(0.8, at);
  }

  /**
   * Finish line. A tihai-shaped fanfare: the same three-note figure three
   * times, landing on the fourth beat — which is how an Indian cadence resolves
   * — over tabla strokes and a held flute note. Ducks the music hard, because
   * this is the one moment the theme should get out of the way.
   */
  finishFanfare(at = this.now): void {
    this.duck(0.75, 1.6, at);
    const hz = (d: number) => ragaHz(BHUPALI, DRIFT_SA * 2, d);
    const step = 0.16;
    for (let rep = 0; rep < 3; rep++) {
      const base = at + rep * step * 3;
      const degrees = [3, 4, 5];
      for (let i = 0; i < degrees.length; i++) {
        this.pluck(base + i * step, degrees[i]!, 0.34, 0.5);
      }
      this.noiseHit(base, 0.09, 0.16, 'bandpass', 2400, 1600, 2.0);
      this.oscHit(base, 0.18, 0.16, 'sine', 200, 78, this.sfx, 0.002);
    }
    const land = at + step * 9;
    this.pluck(land, 5, 0.55, 1.0);
    this.oscHit(land, 0.5, 0.26, 'sine', 220, 80, this.sfx, 0.002);
    this.blow(land, hz(5), 1.1, 0.24, hz(3));
    this.blow(land + 0.02, hz(7), 1.05, 0.12);
    this.crowdCheer(1, land - 0.1);
  }

  dispose(): void {
    this.music?.stop();
    this.music = null;
    try {
      for (const o of this.engineOscs) o.stop();
      this.intakeSource.stop();
      this.overrunSource.stop();
      this.burbleLfo.stop();
      this.scrubSource.stop();
      this.squealTone.stop();
      this.grindLfo.stop();
      this.rumbleSource.stop();
      this.rattleSource.stop();
      this.rattleLfo.stop();
      this.crowdSource.stop();
      this.crowdLfo.stop();
    } catch {
      // Already stopped, or never started. Neither matters at teardown.
    }
    this.master.disconnect();
  }
}
