import { SurfaceKind } from '../core/contracts.ts';
import { AudioEngine, type CueName } from './engine.ts';

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
 * the failure it was written to catch.
 */

export interface CueMeasurement {
  peak: number;
  rms: number;
}

/** Each cue gets a slot. 0.8 s is longer than the longest one-shot (the boost
 *  at 0.5 s) plus its filter tail, so slots cannot bleed into each other and
 *  credit a silent cue with its neighbour's signal. */
const SLOT_SECONDS = 0.8;

const CUES: CueName[] = [
  'engine',
  'scrub',
  'rumble-kerb',
  'rumble-grass',
  'rumble-sand',
  'impact-light',
  'impact-heavy',
  'drift-tier-1',
  'drift-tier-2',
  'drift-tier-3',
  'boost',
  'item-pickup',
  'item-fire',
  'item-hit',
  'lap',
  'countdown',
  'go',
  'crowd',
];

export async function runAudioSelfTest(): Promise<Record<string, CueMeasurement>> {
  const sampleRate = 44100;
  const total = CUES.length * SLOT_SECONDS;
  const OfflineCtor: typeof OfflineAudioContext | undefined =
    typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : undefined;
  if (!OfflineCtor) throw new Error('audio self-test: OfflineAudioContext unavailable');

  const ctx = new OfflineCtor(1, Math.ceil(total * sampleRate), sampleRate);
  const engine = new AudioEngine(ctx, ctx.destination);
  engine.start(0);

  // The continuous voices are silenced between their own slots, so a slot
  // measures its cue and nothing else.
  const silenceAll = (at: number) => {
    engine.setEngine(0, 0, at);
    engine.setScrub(0, at);
    engine.setSurface(SurfaceKind.Road, 0, at);
    engine.setCrowd(0, at);
  };
  silenceAll(0);

  CUES.forEach((cue, i) => {
    const at = i * SLOT_SECONDS + 0.05;
    const end = (i + 1) * SLOT_SECONDS - 0.02;
    switch (cue) {
      case 'engine':
        engine.setEngine(0.8, 1, at);
        engine.setEngine(0, 0, end);
        break;
      case 'scrub':
        engine.setScrub(1, at);
        engine.setScrub(0, end);
        break;
      case 'rumble-kerb':
        engine.setSurface(SurfaceKind.Kerb, 1, at);
        engine.setSurface(SurfaceKind.Road, 0, end);
        break;
      case 'rumble-grass':
        engine.setSurface(SurfaceKind.Grass, 1, at);
        engine.setSurface(SurfaceKind.Road, 0, end);
        break;
      case 'rumble-sand':
        engine.setSurface(SurfaceKind.Sand, 1, at);
        engine.setSurface(SurfaceKind.Road, 0, end);
        break;
      case 'impact-light':
        engine.impact(0.2, at);
        break;
      case 'impact-heavy':
        engine.impact(1, at);
        break;
      case 'drift-tier-1':
        engine.driftTier(1, at);
        break;
      case 'drift-tier-2':
        engine.driftTier(2, at);
        break;
      case 'drift-tier-3':
        engine.driftTier(3, at);
        break;
      case 'boost':
        engine.boost(at);
        break;
      case 'item-pickup':
        engine.itemPickup(at);
        break;
      case 'item-fire':
        engine.itemFire(at);
        break;
      case 'item-hit':
        engine.itemHit(at);
        break;
      case 'lap':
        engine.lap(at);
        break;
      case 'countdown':
        engine.countdownBeep(false, at);
        break;
      case 'go':
        engine.countdownBeep(true, at);
        break;
      case 'crowd':
        engine.setCrowd(1, at);
        engine.setCrowd(0, end);
        break;
    }
  });

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  const out: Record<string, CueMeasurement> = {};

  CUES.forEach((cue, i) => {
    const from = Math.floor(i * SLOT_SECONDS * sampleRate);
    const to = Math.min(data.length, Math.floor((i + 1) * SLOT_SECONDS * sampleRate));
    let peak = 0;
    let sum = 0;
    for (let s = from; s < to; s++) {
      const v = Math.abs(data[s]!);
      if (v > peak) peak = v;
      sum += data[s]! * data[s]!;
    }
    const n = Math.max(1, to - from);
    out[cue] = { peak, rms: Math.sqrt(sum / n) };
  });

  return out;
}
