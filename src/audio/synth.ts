import { Rng } from '../core/rng.ts';

/**
 * Low-level synthesis primitives shared by the sound effects and the music.
 *
 * Everything here takes a `BaseAudioContext`, never an `AudioContext`. That is
 * what lets `selftest.ts` rebuild the identical graph on an
 * `OfflineAudioContext` and measure it. Anything that reaches for
 * `ctx.currentTime` at construction time, or for a node that only a realtime
 * context has, breaks that and is a defect.
 *
 * Every buffer generator is seeded from `core/rng.ts`, so two runs of the
 * self-test produce the same numbers to the last bit. `Math.random` is banned
 * in `src/` and it would make the self-test's numbers meaningless anyway.
 */

/** Deterministic white noise. */
export function makeNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rng = new Rng(seed);
  for (let i = 0; i < length; i++) data[i] = rng.range(-1, 1);
  return buffer;
}

/**
 * A plucked string, Karplus-Strong, rendered into an `AudioBuffer` in plain JS.
 *
 * Why not a `DelayNode` feedback loop, which is the usual Web Audio way? Because
 * the spec requires a **128-sample block of latency inside any cycle** in the
 * graph. That is 2.9 ms at 44.1 kHz, so the loop period is always at least
 * 2.9 ms — the string cannot be tuned above ~344 Hz at all, and below that it
 * is flat by however much of the period the block latency ate unless every
 * delay time is hand-compensated. Rendering the string here is exact at any
 * pitch, is bit-identical offline and live, and lets the whole bank be built
 * once at construction so playing a note allocates nothing.
 *
 * @param hz         Pitch. The delay line is `round(sampleRate / hz)` samples,
 *                   so very high notes quantise; the bank tops out around 1 kHz
 *                   where the error reaches a few cents.
 * @param t60        Seconds for the string to fall 60 dB. This is the loop gain
 *                   in disguise; above ~4 s the averaging filter's own damping
 *                   dominates and the parameter stops doing much.
 * @param brightness 0..1 — how much of the one-pole lowpass is applied to the
 *                   excitation. 0 is a dull, hammered santoor; 1 keeps the
 *                   initial transient bright and metallic, closer to a sitar.
 */
export function makePluckBuffer(
  ctx: BaseAudioContext,
  hz: number,
  seconds: number,
  t60: number,
  seed: number,
  brightness = 0.5,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(2, Math.round(sr / hz));
  const line = new Float32Array(n);
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) line[i] = rng.range(-1, 1);

  // Lowpass the excitation. Raw white noise into the delay line gives a "zzt"
  // attack that reads as a synth blip rather than a struck string.
  const a = 0.15 + 0.75 * brightness;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += (line[i]! - lp) * a;
    line[i] = lp;
  }

  // Loop gain for the requested decay: the delay line is traversed `hz` times a
  // second, and 10^(-3) is -60 dB.
  const decay = Math.pow(10, -3 / Math.max(0.05, t60 * hz));

  const length = Math.max(1, Math.floor(sr * seconds));
  const buffer = ctx.createBuffer(1, length, sr);
  const out = buffer.getChannelData(0);
  let idx = 0;
  let prev = 0;
  let peak = 1e-6;
  for (let i = 0; i < length; i++) {
    const cur = line[idx]!;
    out[i] = cur;
    if (Math.abs(cur) > peak) peak = Math.abs(cur);
    line[idx] = (cur + prev) * 0.5 * decay;
    prev = cur;
    idx = idx + 1 === n ? 0 : idx + 1;
  }

  // Normalise, then fade the last 15 ms. A buffer that is still ringing at its
  // final sample clicks when the source stops, and a click is the one artefact
  // an ear finds instantly.
  const fade = Math.min(length, Math.floor(sr * 0.015));
  const scale = 1 / peak;
  for (let i = 0; i < length; i++) {
    const f = i >= length - fade ? (length - i) / fade : 1;
    out[i] = out[i]! * scale * f;
  }
  return buffer;
}

/**
 * A `WaveShaper` curve that turns a sine LFO into a train of narrow positive
 * pulses. Used for the kerb rattle: kerb ribs are discrete impacts, and a sine
 * used directly as an amplitude modulator gives a smooth wobble that reads as a
 * tremolo pedal, not as a kerb.
 *
 * `exponent` sets how narrow the pulse is. 6 gives a duty cycle around 20%,
 * which is what made the rattle read as separate hits at walking pace instead
 * of as a warble.
 */
export function pulseCurve(exponent: number, size = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = x <= 0 ? 0 : Math.pow(x, exponent);
  }
  return curve;
}

/**
 * An inharmonic partial set for struck metal. Real plate and tube resonances
 * are not integer multiples of anything, and integer harmonics are exactly why
 * a naive "clang" sounds like an organ chord.
 */
export const METAL_PARTIALS: readonly number[] = [1, 1.72, 2.61, 3.41, 4.83];

/** Equal-tempered ratio for a semitone offset. */
export function semitones(n: number): number {
  return Math.pow(2, n / 12);
}
