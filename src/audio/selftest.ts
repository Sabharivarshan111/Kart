import { SurfaceKind } from '../core/contracts.ts';
import { AudioEngine, type CueName } from './engine.ts';
import { Music, type CupThemeId } from './music.ts';

/**
 * The audio self-test.
 *
 * Audio cannot be checked in a screenshot, so it is checked in numbers: rebuild
 * the identical graph on an `OfflineAudioContext`, fire every cue into its own
 * time slot, render, and report peak and RMS per slot.
 *
 * **This proves each cue produces signal. It does not prove it sounds good**,
 * and nothing automated is going to. Saying so plainly is the honest position;
 * a green tick here means "no cue is silently disconnected", which is exactly
 * the failure it was written to catch. A peak of ~0 in any row below is a
 * disconnected cue and is a failure; everything else in the table is
 * descriptive.
 *
 * The second half of the file measures something the ear *can* be wrong about
 * and a number cannot: whether the music sequencer drifts. It renders bars
 * offline and compares the audible onsets against the tempo grid.
 */

export interface CueMeasurement {
  peak: number;
  rms: number;
}

interface CueSpec {
  name: CueName;
  /** Slot length. Long enough for the cue plus its tail, so a slot can never be
   *  credited with its neighbour's signal. */
  seconds: number;
  /** `at` is the cue's start; `end` is when a continuous voice must be back to
   *  silence, 0.3 s before the slot boundary so its decay stays inside. */
  fire: (engine: AudioEngine, at: number, end: number) => void;
}

const CUES: CueSpec[] = [
  // --- continuous voices ---------------------------------------------------
  {
    name: 'engine-idle',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setEngine(0.05, 0.0, at);
      e.setEngine(0, 0, end);
    },
  },
  {
    // Full throttle at three-quarter revs: bright, with intake.
    name: 'engine-accel',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setEngine(0.75, 1, at);
      e.setEngine(0, 0, end);
    },
  },
  {
    // The same road speed, off the throttle. Must measure *different* from
    // engine-accel — that difference is the load character.
    name: 'engine-coast',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setEngine(0.75, 0, at);
      e.setEngine(0, 0, end);
    },
  },
  {
    // The lift edge itself, fired by dropping the throttle in one update.
    name: 'engine-lift',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setEngine(0.8, 1, at);
      e.setEngine(0.78, 0, at + 0.18);
      e.setEngine(0, 0, end);
    },
  },
  {
    name: 'scrub-tarmac',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setScrub(1, SurfaceKind.Road, at);
      e.setScrub(0, SurfaceKind.Road, end);
    },
  },
  {
    name: 'scrub-gravel',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setScrub(1, SurfaceKind.Sand, at);
      e.setScrub(0, SurfaceKind.Road, end);
    },
  },
  {
    name: 'scrub-spray',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setScrub(1, SurfaceKind.Void, at);
      e.setScrub(0, SurfaceKind.Road, end);
    },
  },
  {
    name: 'rumble-kerb',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setSurface(SurfaceKind.Kerb, 1, at);
      e.setSurface(SurfaceKind.Road, 0, end);
    },
  },
  {
    name: 'rumble-grass',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setSurface(SurfaceKind.Grass, 1, at);
      e.setSurface(SurfaceKind.Road, 0, end);
    },
  },
  {
    name: 'rumble-sand',
    seconds: 0.9,
    fire: (e, at, end) => {
      e.setSurface(SurfaceKind.Sand, 1, at);
      e.setSurface(SurfaceKind.Road, 0, end);
    },
  },
  {
    // Kerb at walking pace: the rattle must be separate knocks. Measured as
    // signal here; the *rate* is asserted in measureKerbRattleRate().
    name: 'kerb-rattle-slow',
    seconds: 1.2,
    fire: (e, at, end) => {
      e.setSurface(SurfaceKind.Kerb, 0.2, at);
      e.setSurface(SurfaceKind.Road, 0, end);
    },
  },
  {
    name: 'kerb-rattle-fast',
    seconds: 1.2,
    fire: (e, at, end) => {
      e.setSurface(SurfaceKind.Kerb, 1, at);
      e.setSurface(SurfaceKind.Road, 0, end);
    },
  },
  {
    name: 'crowd',
    seconds: 1.2,
    fire: (e, at, end) => {
      e.setCrowd(1, at);
      e.setCrowd(0, end);
    },
  },
  { name: 'crowd-cheer', seconds: 2.2, fire: (e, at) => e.crowdCheer(1, at) },

  // --- one-shots -----------------------------------------------------------
  { name: 'impact-light', seconds: 0.9, fire: (e, at) => e.impact(0.2, at) },
  { name: 'impact-heavy', seconds: 0.9, fire: (e, at) => e.impact(1, at) },
  { name: 'drift-hop', seconds: 0.9, fire: (e, at) => e.driftHop(at) },
  { name: 'drift-tier-1', seconds: 0.9, fire: (e, at) => e.driftTier(1, at) },
  { name: 'drift-tier-2', seconds: 0.9, fire: (e, at) => e.driftTier(2, at) },
  { name: 'drift-tier-3', seconds: 1.2, fire: (e, at) => e.driftTier(3, at) },
  { name: 'boost', seconds: 1.2, fire: (e, at) => e.boost(at) },
  { name: 'spin-out', seconds: 1.5, fire: (e, at) => e.spinOut(at) },
  { name: 'respawn', seconds: 1.5, fire: (e, at) => e.respawn(at) },
  { name: 'item-box', seconds: 1.2, fire: (e, at) => e.itemBox(at) },
  { name: 'item-pickup', seconds: 1.2, fire: (e, at) => e.itemPickup(at) },
  { name: 'item-fire', seconds: 0.9, fire: (e, at) => e.itemFire(at) },
  { name: 'item-hit', seconds: 1.2, fire: (e, at) => e.itemHit(at) },
  { name: 'lap', seconds: 1.2, fire: (e, at) => e.lap(at) },
  { name: 'countdown', seconds: 0.9, fire: (e, at) => e.countdownBeep(false, at) },
  { name: 'go', seconds: 2.2, fire: (e, at) => e.countdownBeep(true, at) },
  { name: 'finish-fanfare', seconds: 4.0, fire: (e, at) => e.finishFanfare(at) },

  // --- music ---------------------------------------------------------------
  // Each theme gets several bars. The offline context has no pump — there is no
  // wall clock to pump against — so the scheduler is asked once for the whole
  // window, which is the same call the live pump makes with a shorter horizon.
  {
    name: 'music-copper',
    seconds: 6.0,
    fire: (e, at, end) => {
      const m = e.startMusic('copper', at, 1);
      m.scheduleUntil(end);
      m.setLevel(0.0001, end, 0.1);
    },
  },
  {
    name: 'music-lantern',
    seconds: 6.0,
    fire: (e, at, end) => {
      const m = e.startMusic('lantern', at, 1);
      m.scheduleUntil(end);
      m.setLevel(0.0001, end, 0.1);
    },
  },
];

function offlineCtor(): typeof OfflineAudioContext {
  const ctor: typeof OfflineAudioContext | undefined =
    typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : undefined;
  if (!ctor) throw new Error('audio self-test: OfflineAudioContext unavailable');
  return ctor;
}

export async function runAudioSelfTest(): Promise<Record<string, CueMeasurement>> {
  const sampleRate = 44100;
  const starts: number[] = [];
  let total = 0;
  for (const cue of CUES) {
    starts.push(total);
    total += cue.seconds;
  }

  const ctx = new (offlineCtor())(1, Math.ceil(total * sampleRate), sampleRate);
  const engine = new AudioEngine(ctx, ctx.destination);
  engine.start(0);

  // Continuous voices are silenced outside their own slots, so a slot measures
  // its cue and nothing else.
  engine.setEngine(0, 0, 0);
  engine.setScrub(0, SurfaceKind.Road, 0);
  engine.setSurface(SurfaceKind.Road, 0, 0);
  engine.setCrowd(0, 0);

  CUES.forEach((cue, i) => {
    const at = starts[i]! + 0.04;
    const end = starts[i]! + cue.seconds - 0.30;
    cue.fire(engine, at, end);
  });

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  const out: Record<string, CueMeasurement> = {};

  CUES.forEach((cue, i) => {
    const from = Math.floor(starts[i]! * sampleRate);
    const to = Math.min(data.length, Math.floor((starts[i]! + cue.seconds) * sampleRate));
    let peak = 0;
    let sum = 0;
    for (let s = from; s < to; s++) {
      const v = Math.abs(data[s]!);
      if (v > peak) peak = v;
      sum += data[s]! * data[s]!;
    }
    out[cue.name] = { peak, rms: Math.sqrt(sum / Math.max(1, to - from)) };
  });

  return out;
}

/** A fixed-width table of the measurements, for a report or a console. */
export function formatCueTable(result: Record<string, CueMeasurement>): string {
  const names = Object.keys(result);
  const w = Math.max(...names.map((n) => n.length), 4);
  const lines = [
    `${'cue'.padEnd(w)}  ${'peak'.padStart(8)}  ${'rms'.padStart(8)}`,
    `${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}`,
  ];
  for (const n of names) {
    const m = result[n]!;
    lines.push(`${n.padEnd(w)}  ${m.peak.toFixed(5).padStart(8)}  ${m.rms.toFixed(5).padStart(8)}`);
  }
  return lines.join('\n');
}

// ===========================================================================
//  Sequencer drift
// ===========================================================================

export interface DriftReport {
  theme: CupThemeId;
  bpm: number;
  taal: string;
  seconds: number;
  /** Tabla strokes the scheduler emitted. */
  scheduled: number;
  /** Onsets found in the rendered audio. */
  detected: number;
  /** Scheduled strokes with no onset within 40 ms. Must be 0. */
  unmatched: number;
  /**
   * Worst |scheduled time − ideal grid time| in ms. This is the scheduler's own
   * arithmetic: `startTime + beat * secondsPerBeat` versus the beat the note was
   * written on. Anything but ~0 means the sequencer accumulates.
   */
  maxGridErrorMs: number;
  /**
   * Median lag from a note's scheduled time to its audible onset, in ms. This is
   * a *constant* — the envelope attack plus the detector's threshold — and is
   * not drift. It is reported so the number below is honest about what was
   * subtracted.
   */
  medianOnsetLagMs: number;
  /**
   * The drift: the worst deviation of an onset from the constant lag, in ms.
   * A sequencer running off a timer shows this growing with time; one running
   * off the audio clock does not.
   */
  maxOnsetDeviationMs: number;
  /** Same, over the last quarter of the render only. If the number above is
   *  drift rather than jitter, this one is larger. */
  lateWindowDeviationMs: number;
  /** Notes the scheduler reached after their time had passed. Offline this must
   *  be 0; live it is the pump falling behind LOOKAHEAD. */
  lateNotes: number;
}

/**
 * Render `cycles` cycles of a theme's tabla alone and check that the strokes
 * land where the tempo says.
 *
 * Tabla alone, not the full mix: every stroke is then a sharp attack at a known
 * grid position, and the onset detector is not trying to pick a downbeat out of
 * a flute glide. The drone bed is muted with it — a continuous pad under the
 * hits would sit above the detector's floor.
 */
export async function measureSequencerDrift(
  theme: CupThemeId,
  cycles = 6,
  sampleRate = 48000,
): Promise<DriftReport> {
  // A probe instance, only to read the tempo before sizing the render.
  const probeCtx = new (offlineCtor())(1, 128, sampleRate);
  const probe = new Music(probeCtx, probeCtx.destination, theme);
  const cycleSeconds = probe.theme.beatsPerCycle * probe.secondsPerBeat;
  const seconds = cycleSeconds * cycles + 1.0;
  probe.stop();

  const ctx = new (offlineCtor())(1, Math.ceil(seconds * sampleRate), sampleRate);
  const music = new Music(ctx, ctx.destination, theme);
  music.diagnostics = true;
  music.soloTabla();
  // Full level immediately: a fade would scale the early hits and bias the
  // detector's peak-relative threshold.
  music.start(0.5, 0.001, 1);
  music.scheduleUntil(seconds - 0.2);

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);

  const scheduled = music.log.filter((e) => e.part === 'tabla').map((e) => e.time).sort((a, b) => a - b);

  // Ideal grid: the beat index the note was written on, times the beat length,
  // from the anchor. Compared against what the scheduler actually emitted.
  let maxGridError = 0;
  for (const e of music.log) {
    if (e.part !== 'tabla') continue;
    const ideal = music.beatTime(e.beat);
    maxGridError = Math.max(maxGridError, Math.abs(e.time - ideal));
  }

  const onsets = detectOnsets(data, sampleRate);

  const errors: { t: number; err: number }[] = [];
  let unmatched = 0;
  for (const t of scheduled) {
    let best = Number.POSITIVE_INFINITY;
    for (const o of onsets) {
      const d = o - t;
      if (Math.abs(d) < Math.abs(best)) best = d;
    }
    if (!Number.isFinite(best) || Math.abs(best) > 0.04) {
      unmatched++;
      continue;
    }
    errors.push({ t, err: best });
  }

  const sortedErr = errors.map((e) => e.err).sort((a, b) => a - b);
  const median = sortedErr.length ? sortedErr[Math.floor(sortedErr.length / 2)]! : 0;
  let maxDev = 0;
  let lateDev = 0;
  const lateFrom = 0.5 + (seconds - 0.5) * 0.75;
  for (const e of errors) {
    const dev = Math.abs(e.err - median);
    if (dev > maxDev) maxDev = dev;
    if (e.t >= lateFrom && dev > lateDev) lateDev = dev;
  }

  const report: DriftReport = {
    theme,
    bpm: music.theme.bpm,
    taal: music.theme.taal,
    seconds,
    scheduled: scheduled.length,
    detected: onsets.length,
    unmatched,
    maxGridErrorMs: maxGridError * 1000,
    medianOnsetLagMs: median * 1000,
    maxOnsetDeviationMs: maxDev * 1000,
    lateWindowDeviationMs: lateDev * 1000,
    lateNotes: music.lateNotes,
  };
  music.stop();
  return report;
}

/**
 * Percussive onset detection.
 *
 * Two passes. First a fast-attack, 6 ms-release envelope finds *where* the hits
 * are, with hysteresis so one hit is not counted twice as it decays. Then, for
 * each hit, the local peak is found and the onset is backed up to the first
 * sample above 15% of that peak — relative to the hit's own peak, because the
 * strokes differ by 20 dB and a fixed threshold would put a quiet ghost stroke's
 * onset later than a loud one's purely because it is quiet, which would look
 * exactly like jitter.
 */
function detectOnsets(data: Float32Array, sampleRate: number): number[] {
  const release = Math.exp(-1 / (0.006 * sampleRate));
  const openAt = 0.012;
  const closeAt = 0.006;
  const lookAhead = Math.floor(sampleRate * 0.025);
  const lookBack = Math.floor(sampleRate * 0.012);

  const onsets: number[] = [];
  let env = 0;
  let armed = true;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]!);
    env = v > env ? v : env * release;
    if (armed && env > openAt) {
      let peak = 0;
      const to = Math.min(data.length, i + lookAhead);
      for (let j = i; j < to; j++) {
        const a = Math.abs(data[j]!);
        if (a > peak) peak = a;
      }
      const trigger = peak * 0.15;
      let onset = i;
      for (let j = Math.max(0, i - lookBack); j < to; j++) {
        if (Math.abs(data[j]!) >= trigger) {
          onset = j;
          break;
        }
      }
      onsets.push(onset / sampleRate);
      armed = false;
    } else if (!armed && env < closeAt) {
      armed = true;
    }
  }
  return onsets;
}

/**
 * The kerb rattle's *rate*, measured rather than asserted.
 *
 * The cue's whole point is that the knock rate tracks road speed. Peak and RMS
 * cannot see that — a louder hiss measures the same — so this counts the
 * amplitude peaks in a rendered second at two speeds and reports them.
 */
export async function measureKerbRattleRate(
  speedFraction: number,
  sampleRate = 44100,
): Promise<{ speedFraction: number; hits: number; hz: number }> {
  const seconds = 1.6;
  const ctx = new (offlineCtor())(1, Math.ceil(seconds * sampleRate), sampleRate);
  const engine = new AudioEngine(ctx, ctx.destination);
  engine.start(0);
  engine.setEngine(0, 0, 0);
  engine.setScrub(0, SurfaceKind.Road, 0);
  engine.setCrowd(0, 0);
  engine.setSurface(SurfaceKind.Kerb, speedFraction, 0);
  const rendered = await ctx.startRendering();
  // Measure the last second only: the first 0.6 s is the setTargetAtTime ramp
  // getting the depth and rate to where they were asked for.
  const from = Math.floor(0.6 * sampleRate);
  const window = rendered.getChannelData(0).slice(from);
  const onsets = detectOnsets(window, sampleRate);
  const span = window.length / sampleRate;
  return { speedFraction, hits: onsets.length, hz: onsets.length / span };
}
