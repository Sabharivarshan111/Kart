import { BHUPALI, CHARUKESHI, ragaHz, type Raga } from './raga.ts';
import { makeNoiseBuffer, makePluckBuffer } from './synth.ts';

/**
 * The music: two cup themes, entirely synthesised, with Indian instrumentation
 * evoked through synthesis rather than sampled.
 *
 * Four voices, all built from oscillators and generated buffers:
 *
 * - **Tabla-like** membrane hits. A pitch-swept sine is the membrane (the bayan
 *   gliss is the single most recognisable thing about the instrument, and it is
 *   literally a downward pitch sweep), and a short filtered noise burst is the
 *   strike. Seven strokes, so a theka reads as a theka and not as a drum
 *   machine.
 * - **Tanpura-like drone**: detuned sustained oscillators at Sa and Pa, plus the
 *   cycling four-string pluck (Pa Sa Sa Sa) that gives a real tanpura its pulse.
 * - **Plucked string**, Karplus-Strong, from a bank built once per theme.
 * - **Bansuri-like flute**: sine plus a weak second harmonic plus a breath noise
 *   band, with vibrato and — the part that matters — *meend*, the glide between
 *   notes. A bansuri line without glides sounds like a recorder.
 *
 * ## The scheduler
 *
 * Note times come from a **look-ahead scheduler against the AudioContext
 * clock**. `setInterval` appears exactly once, as a pump that asks "schedule
 * everything due in the next 250 ms" — it never decides *when* a note sounds.
 * Every note time is `startTime + beatIndex * secondsPerBeat`, computed from an
 * absolute anchor and an integer, so there is nothing to accumulate error into.
 *
 * This is not fussiness. A timer on a thread that is also running 120 Hz physics
 * and a full render is late by whatever the frame cost is, every time it fires;
 * sequencing from the timer adds that lateness into the next note's position and
 * the drift is audible inside a bar. `measureSequencerDrift()` in `selftest.ts`
 * renders bars offline and checks the onsets land where the tempo says.
 */

export type CupThemeId = 'copper' | 'lantern';

/** Tabla strokes (bols). Bass = bayan, skin = dayan, plus the strike noise. */
export type Bol = 'dha' | 'dhin' | 'na' | 'tin' | 'ta' | 'ge' | 'ke';

type Part = 'drone' | 'tabla' | 'pluck' | 'flute';

interface TablaEvent {
  part: 'tabla';
  /** Beats from the start of the phrase. */
  beat: number;
  bol: Bol;
  gain: number;
}

interface NoteEvent {
  part: 'drone' | 'pluck' | 'flute';
  beat: number;
  /** Scale degree in the theme's raga; wraps by octaves, negatives allowed. */
  degree: number;
  /** Length in beats. */
  length: number;
  gain: number;
  /** Flute only: glide up from this degree (meend). */
  from?: number;
}

type Event = TablaEvent | NoteEvent;

export interface ScheduledEvent {
  part: Part;
  /** Absolute AudioContext time the voice was scheduled to begin. */
  time: number;
  /** Beat index from the start of the piece, phrase repeats included. */
  beat: number;
  bol?: Bol;
  degree?: number;
}

interface ThemeSpec {
  id: CupThemeId;
  name: string;
  raga: Raga;
  /** Hz of Sa. Absolute pitch is arbitrary — a raga is relative to its tonic —
   *  chosen so the flute sits in a bright register and the pluck bank never
   *  needs a string below ~90 Hz, where the delay line gets long and dull. */
  sa: number;
  bpm: number;
  /** Beats in one cycle of the taal. */
  beatsPerCycle: number;
  /** Cycles in one repeat of the written phrase. */
  cyclesPerPhrase: number;
  taal: string;
  events: Event[];
  mix: { drone: number; tabla: number; pluck: number; flute: number };
}

// ---------------------------------------------------------------------------
//  Stroke voicing
// ---------------------------------------------------------------------------

interface BolSpec {
  /** Bayan (bass drum): swept sine, ratio against Sa, and how far it falls. */
  bassFrom: number;
  bassTo: number;
  bassGain: number;
  bassDecay: number;
  /** Dayan (treble drum): a pitched membrane ring. */
  skinRatio: number;
  skinGain: number;
  skinDecay: number;
  /** The strike itself. */
  noiseHz: number;
  noiseQ: number;
  noiseGain: number;
  noiseDecay: number;
}

/**
 * Ratios are against Sa so the drums stay in tune with the raga when a theme
 * moves its tonic — a tabla is tuned to the tonic and a drum a semitone out is
 * the fastest way to make synthesised Indian percussion sound wrong.
 */
const BOLS: Record<Bol, BolSpec> = {
  // Bass and skin together, the full open stroke.
  dha: { bassFrom: 1.30, bassTo: 0.50, bassGain: 0.85, bassDecay: 0.40, skinRatio: 2.00, skinGain: 0.30, skinDecay: 0.20, noiseHz: 1900, noiseQ: 1.1, noiseGain: 0.24, noiseDecay: 0.030 },
  dhin: { bassFrom: 1.24, bassTo: 0.52, bassGain: 0.70, bassDecay: 0.34, skinRatio: 3.00, skinGain: 0.34, skinDecay: 0.30, noiseHz: 2300, noiseQ: 1.3, noiseGain: 0.20, noiseDecay: 0.024 },
  // Skin only, open and ringing — the rim stroke that carries the pulse.
  na: { bassFrom: 0, bassTo: 0, bassGain: 0, bassDecay: 0.01, skinRatio: 3.00, skinGain: 0.40, skinDecay: 0.26, noiseHz: 2600, noiseQ: 1.6, noiseGain: 0.22, noiseDecay: 0.020 },
  tin: { bassFrom: 0, bassTo: 0, bassGain: 0, bassDecay: 0.01, skinRatio: 4.00, skinGain: 0.34, skinDecay: 0.22, noiseHz: 3100, noiseQ: 1.8, noiseGain: 0.20, noiseDecay: 0.016 },
  // Closed slaps: almost all strike, no ring. These are the ghost notes.
  ta: { bassFrom: 0, bassTo: 0, bassGain: 0, bassDecay: 0.01, skinRatio: 3.60, skinGain: 0.10, skinDecay: 0.05, noiseHz: 3400, noiseQ: 0.9, noiseGain: 0.20, noiseDecay: 0.014 },
  ke: { bassFrom: 0.95, bassTo: 0.72, bassGain: 0.26, bassDecay: 0.07, skinRatio: 0, skinGain: 0, skinDecay: 0.01, noiseHz: 700, noiseQ: 0.7, noiseGain: 0.11, noiseDecay: 0.020 },
  // Bass only, damped: the "ge" of the Keherwa theka.
  ge: { bassFrom: 1.15, bassTo: 0.56, bassGain: 0.52, bassDecay: 0.22, skinRatio: 0, skinGain: 0, skinDecay: 0.01, noiseHz: 900, noiseQ: 0.8, noiseGain: 0.09, noiseDecay: 0.018 },
};

// ---------------------------------------------------------------------------
//  Theme material
// ---------------------------------------------------------------------------

function tabla(beat: number, bol: Bol, gain = 1): TablaEvent {
  return { part: 'tabla', beat, bol, gain };
}
function pluck(beat: number, degree: number, length: number, gain = 1): NoteEvent {
  return { part: 'pluck', beat, degree, length, gain };
}
function flute(beat: number, degree: number, length: number, gain = 1, from?: number): NoteEvent {
  return { part: 'flute', beat, degree, length, gain, from };
}
function drone(beat: number, degree: number, length: number, gain = 1): NoteEvent {
  return { part: 'drone', beat, degree, length, gain };
}

/**
 * Copper cup — **Raga Bhupali**, note set S R G P D (C D E G A with Sa = C).
 *
 * Keherwa, the eight-beat taal, at 132 BPM: fast, four-square and easy to hear
 * the "1" of, which is what a racing cue needs. The theka is
 * *Dha Ge Na Ti | Na Ka Dhi Na*, with offbeat ghost strokes added for drive.
 *
 * The flute phrase climbs the aroha across the first two cycles and comes to
 * rest on Ga, Bhupali's vadi. There is deliberately no Ma and no Ni anywhere in
 * this file's Bhupali material — that omission *is* the raga.
 */
function copperTheme(): ThemeSpec {
  const beatsPerCycle = 8;
  const cyclesPerPhrase = 4;
  const events: Event[] = [];

  for (let c = 0; c < cyclesPerPhrase; c++) {
    const b = c * beatsPerCycle;
    // Keherwa theka, one bol per beat.
    const theka: Bol[] = ['dha', 'ge', 'na', 'ta', 'na', 'ke', 'dhin', 'na'];
    for (let i = 0; i < theka.length; i++) {
      events.push(tabla(b + i, theka[i]!, i === 0 ? 1 : 0.82));
    }
    // Offbeat ghosts. Dropped in the last cycle so the phrase breathes before
    // it repeats — a pattern with no hole in it stops being a pattern.
    if (c < cyclesPerPhrase - 1) {
      for (const off of [1.5, 3.5, 5.5]) events.push(tabla(b + off, 'ta', 0.38));
    }
    // Tihai-ish fill into the repeat.
    if (c === cyclesPerPhrase - 1) {
      for (const off of [6.5, 7.0, 7.5]) events.push(tabla(b + off, 'tin', 0.55));
    }
    // Tanpura: Pa Sa Sa Sa, the classic cycling order, two beats apart.
    const strings = [3, 5, 5, 5];
    for (let i = 0; i < 4; i++) events.push(drone(b + i * 2, strings[i]!, 2, 0.5));
  }

  // Pluck ostinato, one figure per cycle, moved up the raga's own degrees.
  const figure = [0, 2, 3, 4, 3, 2, 3, 1];
  const lift = [0, 0, 1, 0];
  for (let c = 0; c < cyclesPerPhrase; c++) {
    for (let i = 0; i < figure.length; i++) {
      events.push(pluck(c * beatsPerCycle + i, figure[i]! + lift[c]!, 1, i % 2 === 0 ? 0.8 : 0.55));
    }
  }

  // Bansuri line. `from` is the meend — the glide the flute slides up or down
  // from, and the thing that stops it sounding like a recorder.
  events.push(
    flute(0, 2, 1.5, 0.9, 1),
    flute(1.5, 3, 0.5, 0.7),
    flute(2, 4, 1, 0.85),
    flute(3, 5, 1.5, 0.95, 4),
    flute(4.5, 4, 1.5, 0.7),
    flute(6, 3, 2, 0.8, 4),

    flute(8, 2, 1, 0.8),
    flute(9, 1, 1, 0.7),
    flute(10, 2, 2, 0.85, 1),
    flute(12, 3, 1.5, 0.8),
    flute(13.5, 2, 0.5, 0.6),
    flute(14, 1, 2, 0.75, 2),

    flute(16, 3, 1, 0.85),
    flute(17, 4, 1, 0.85),
    flute(18, 5, 2, 1.0, 4),
    flute(20, 6, 1, 0.9),
    flute(21, 5, 1, 0.8, 6),
    flute(22, 4, 2, 0.8),

    flute(24, 3, 1.5, 0.85),
    flute(25.5, 2, 0.5, 0.6),
    flute(26, 1, 1, 0.7),
    flute(27, 0, 1, 0.75),
    // Rest on Ga, the vadi.
    flute(28, 2, 3.5, 0.9, 0),
  );

  return {
    id: 'copper',
    name: 'Copper Cup',
    raga: BHUPALI,
    sa: 146.83, // D3
    bpm: 132,
    beatsPerCycle,
    cyclesPerPhrase,
    taal: 'Keherwa (8 beats)',
    events,
    mix: { drone: 0.16, tabla: 0.5, pluck: 0.34, flute: 0.28 },
  };
}

/**
 * Lantern cup — **Raga Charukeshi**, note set S R G m P d n
 * (C D E F G A♭ B♭ with Sa = C).
 *
 * Teental, sixteen beats, at 100 BPM: slower, longer-breathed, and the extra
 * length is what lets the flute actually glide. The theka is
 * *Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dha Tin Tin Ta | Ta Dhin Dhin Dha*,
 * with the khali (the empty third quarter, Tin/Ta) left as bare skin strokes —
 * that hole is how a listener knows where they are in a sixteen-beat cycle.
 */
function lanternTheme(): ThemeSpec {
  const beatsPerCycle = 16;
  const cyclesPerPhrase = 2;
  const events: Event[] = [];

  const theka: Bol[] = [
    'dha', 'dhin', 'dhin', 'dha',
    'dha', 'dhin', 'dhin', 'dha',
    'dha', 'tin', 'tin', 'ta',
    'ta', 'dhin', 'dhin', 'dha',
  ];
  for (let c = 0; c < cyclesPerPhrase; c++) {
    const b = c * beatsPerCycle;
    for (let i = 0; i < theka.length; i++) {
      // Sam (beat 1) is the accent the whole cycle resolves onto.
      events.push(tabla(b + i, theka[i]!, i === 0 ? 1 : i % 4 === 0 ? 0.8 : 0.62));
    }
    for (const off of [2.5, 6.5, 14.5]) events.push(tabla(b + off, 'ke', 0.3));
    // Tanpura, four strings over the cycle.
    const strings = [4, 7, 7, 7];
    for (let i = 0; i < 4; i++) events.push(drone(b + i * 4, strings[i]!, 4, 0.55));
  }

  // Pluck: a slow santoor-ish figure, sparser than the copper cup's.
  const figure: [number, number, number][] = [
    [0, 0, 1.5], [1.5, 2, 0.5], [2, 3, 1], [3, 4, 1],
    [5, 5, 1.5], [6.5, 4, 0.5], [7, 3, 1],
    [9, 4, 1], [10, 2, 2], [12, 1, 1], [13, 0, 1.5],
  ];
  for (let c = 0; c < cyclesPerPhrase; c++) {
    for (const [beat, degree, length] of figure) {
      events.push(pluck(c * beatsPerCycle + beat, degree + (c === 1 ? 3 : 0), length, 0.7));
    }
  }

  // Flute. Long notes, most of them entered on a glide — Charukeshi's flat dha
  // and ni are where the raga's character lives, so the line leans on them.
  events.push(
    flute(0, 4, 3, 0.95, 2),
    flute(3, 5, 1, 0.8),
    flute(4, 6, 2, 0.9, 5),
    flute(6, 7, 2, 1.0, 6),
    flute(8, 5, 2, 0.8, 7),
    flute(10, 4, 2, 0.85),
    flute(12, 3, 2, 0.75, 4),
    flute(14, 2, 2, 0.8),

    flute(16, 4, 2, 0.9, 3),
    flute(18, 7, 2, 0.95, 5),
    flute(20, 8, 2, 1.0, 7),
    flute(22, 7, 1, 0.85),
    flute(23, 5, 2, 0.8, 7),
    flute(25, 6, 1.5, 0.8),
    flute(26.5, 4, 1.5, 0.75, 6),
    // Comes to rest on Pa, Charukeshi's vadi.
    flute(28, 4, 4, 0.9, 3),
  );

  return {
    id: 'lantern',
    name: 'Lantern Cup',
    raga: CHARUKESHI,
    sa: 130.81, // C3
    bpm: 100,
    beatsPerCycle,
    cyclesPerPhrase,
    taal: 'Teental (16 beats)',
    events,
    mix: { drone: 0.2, tabla: 0.44, pluck: 0.3, flute: 0.3 },
  };
}

export const CUP_THEMES: Record<CupThemeId, () => ThemeSpec> = {
  copper: copperTheme,
  lantern: lanternTheme,
};

/** Description of a theme for the report and the self-test, without building
 *  the audio graph. */
export function describeTheme(id: CupThemeId): {
  id: CupThemeId;
  name: string;
  raga: string;
  swaras: string;
  taal: string;
  bpm: number;
  phraseBeats: number;
} {
  const t = CUP_THEMES[id]();
  return {
    id: t.id,
    name: t.name,
    raga: t.raga.name,
    swaras: t.raga.swaras.join(' '),
    taal: t.taal,
    bpm: t.bpm,
    phraseBeats: t.beatsPerCycle * t.cyclesPerPhrase,
  };
}

// ---------------------------------------------------------------------------
//  The player
// ---------------------------------------------------------------------------

/** How far ahead the pump schedules. Comfortably longer than any frame this
 *  game produces, including a 66 ms worst-case physics catch-up plus a GC
 *  pause: if the pump is ever later than this the music has a gap, and 250 ms
 *  is the margin that made that stop happening under a full race load. */
const LOOKAHEAD = 0.25;
/** Pump interval. Short relative to LOOKAHEAD so several pumps cover every
 *  window; the pump's own timing accuracy is irrelevant by construction. */
const PUMP_MS = 40;

/** Lowest and highest pluck-bank degrees. The bank is built once per theme. */
const BANK_LOW = -3;
const BANK_HIGH = 12;

export class Music {
  readonly ctx: BaseAudioContext;
  readonly bus: GainNode;
  readonly theme: ThemeSpec;

  /** Diagnostics for the drift test. Off by default: the game does not need a
   *  growing array of every note it has ever played. */
  diagnostics = false;
  readonly log: ScheduledEvent[] = [];
  /** Notes the pump reached only after their time had already passed. Should be
   *  zero; a non-zero count in a real session means LOOKAHEAD is too short. */
  lateNotes = 0;

  private readonly mute: Record<Part, boolean> = {
    drone: false, tabla: false, pluck: false, flute: false,
  };

  private readonly noise: AudioBuffer;
  private readonly bank: AudioBuffer[] = [];
  private readonly partGain: Record<Part, GainNode>;
  private readonly droneOscs: OscillatorNode[] = [];
  private readonly droneBed: GainNode;

  private readonly sorted: Event[];
  private readonly phraseBeats: number;
  private readonly spb: number;

  private startTime = 0;
  private cursor = 0;
  private phrase = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: BaseAudioContext, destination: AudioNode, id: CupThemeId) {
    this.ctx = ctx;
    this.theme = CUP_THEMES[id]();
    this.spb = 60 / this.theme.bpm;
    this.phraseBeats = this.theme.beatsPerCycle * this.theme.cyclesPerPhrase;
    this.sorted = [...this.theme.events].sort((a, b) => a.beat - b.beat);

    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(destination);

    const makePart = (level: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(this.bus);
      return g;
    };
    this.partGain = {
      drone: makePart(this.theme.mix.drone),
      tabla: makePart(this.theme.mix.tabla),
      pluck: makePart(this.theme.mix.pluck),
      flute: makePart(this.theme.mix.flute),
    };

    this.noise = makeNoiseBuffer(ctx, 2.3, 0x9a17 + (id === 'copper' ? 0 : 977));

    // Pluck bank, built once. Playing a note is then a buffer source and two
    // gains — no per-note synthesis, no allocation spike on the beat.
    for (let d = BANK_LOW; d <= BANK_HIGH; d++) {
      const hz = ragaHz(this.theme.raga, this.theme.sa, d);
      // Longer strings ring longer, as they do physically; the 1.15 s floor
      // keeps a high note from being a click.
      const t60 = Math.max(1.15, 3.4 - d * 0.11);
      this.bank.push(makePluckBuffer(ctx, hz, Math.min(2.6, t60), t60, 0x4f00 + d * 131, 0.55));
    }

    // Tanpura bed: three sustained voices, slightly detuned so they beat against
    // each other. A single oscillator per pitch is a test tone; the beating is
    // the whole reason the drone sits under the mix without being noticed.
    this.droneBed = ctx.createGain();
    this.droneBed.gain.value = 0.5;
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 780;
    bedFilter.Q.value = 0.4;
    this.droneBed.connect(bedFilter);
    bedFilter.connect(this.partGain.drone);
    const bedPitches = [
      { degree: 0, detune: -4, level: 1.0, type: 'sawtooth' as OscillatorType },
      { degree: 0, detune: +5, level: 0.7, type: 'triangle' as OscillatorType },
      // Pa for Bhupali is degree 3, for Charukeshi degree 4 — index the raga
      // rather than hardcoding a fifth, or a five-note raga gets the wrong note.
      { degree: this.theme.raga.id === 'bhupali' ? 3 : 4, detune: +2, level: 0.55, type: 'sawtooth' as OscillatorType },
    ];
    for (const p of bedPitches) {
      const osc = ctx.createOscillator();
      osc.type = p.type;
      osc.frequency.value = ragaHz(this.theme.raga, this.theme.sa, p.degree) * 0.5;
      osc.detune.value = p.detune;
      const g = ctx.createGain();
      g.gain.value = 0.16 * p.level;
      osc.connect(g);
      g.connect(this.droneBed);
      this.droneOscs.push(osc);
    }
  }

  /** Start the piece at an absolute context time. */
  start(when: number, fadeSeconds = 1.2, level = 1): void {
    if (this.running) return;
    this.running = true;
    this.startTime = when;
    this.cursor = 0;
    this.phrase = 0;
    for (const o of this.droneOscs) o.start(when);
    this.bus.gain.setValueAtTime(0.0001, when);
    this.bus.gain.linearRampToValueAtTime(level, when + fadeSeconds);

    // The pump. It exists only to ask the question; the answer is always
    // computed from the AudioContext clock and an integer beat index.
    if (typeof setInterval === 'function' && !('startRendering' in this.ctx)) {
      this.timer = setInterval(() => {
        this.scheduleUntil(this.ctx.currentTime + LOOKAHEAD);
      }, PUMP_MS);
    }
    this.scheduleUntil(when + LOOKAHEAD);
  }

  /** Absolute time of a beat index, from the anchor. Never accumulated — this
   *  one line is why the sequencer cannot drift. */
  beatTime(beatIndex: number): number {
    return this.startTime + beatIndex * this.spb;
  }

  get secondsPerBeat(): number {
    return this.spb;
  }
  get beatsPerPhrase(): number {
    return this.phraseBeats;
  }

  /** Emit every voice due before `audioTime`. Idempotent in the sense that it
   *  never re-emits: the cursor only moves forward. */
  scheduleUntil(audioTime: number): void {
    if (!this.running) return;
    // Bounded so a pathological argument (a wrong offline length, say) cannot
    // hang the thread building an unbounded number of nodes.
    let guard = 20000;
    while (guard-- > 0) {
      const ev = this.sorted[this.cursor];
      if (!ev) {
        this.phrase++;
        this.cursor = 0;
        continue;
      }
      const beat = this.phrase * this.phraseBeats + ev.beat;
      const t = this.beatTime(beat);
      if (t >= audioTime) return;
      this.cursor++;
      if (!this.mute[ev.part]) this.emit(ev, t, beat);
    }
  }

  private emit(ev: Event, t: number, beat: number): void {
    // Clamp only if the pump was so late the note is already in the past. The
    // note is then early-by-being-late rather than dropped, and the counter says
    // it happened — silently mangling timing is how a sequencer gets a
    // reputation for "feeling loose".
    const now = this.ctx.currentTime;
    const at = t < now ? (this.lateNotes++, now + 0.001) : t;

    if (this.diagnostics) {
      this.log.push(
        ev.part === 'tabla'
          ? { part: 'tabla', time: at, beat, bol: ev.bol }
          : { part: ev.part, time: at, beat, degree: ev.degree },
      );
    }

    switch (ev.part) {
      case 'tabla':
        this.tabla(at, ev.bol, ev.gain);
        break;
      case 'pluck':
        this.pluck(at, ev.degree, ev.length * this.spb, ev.gain);
        break;
      case 'drone':
        this.pluck(at, ev.degree, ev.length * this.spb, ev.gain * 0.5, this.partGain.drone, 0.35);
        break;
      case 'flute':
        this.flute(at, ev.degree, ev.length * this.spb, ev.gain, ev.from);
        break;
    }
  }

  // --- instruments ---------------------------------------------------------

  /** A tabla-like stroke: swept membrane sine(s) plus a filtered strike. */
  tabla(at: number, bol: Bol, gain = 1): void {
    const spec = BOLS[bol];
    const dest = this.partGain.tabla;
    const sa = this.theme.sa;

    if (spec.bassGain > 0) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(sa * spec.bassFrom, at);
      // The bayan gliss. Exponential, over 55 ms: the sweep is the instrument's
      // signature and a linear one sounds like a kick drum instead.
      osc.frequency.exponentialRampToValueAtTime(sa * spec.bassTo, at + 0.055);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      // Linear 1.5 ms attack, not an exponential ramp from near-zero: the onset
      // is then where the note says it is, which is what the drift test
      // measures against.
      g.gain.linearRampToValueAtTime(spec.bassGain * gain, at + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + spec.bassDecay);
      osc.connect(g);
      g.connect(dest);
      osc.start(at);
      osc.stop(at + spec.bassDecay + 0.02);
    }

    if (spec.skinGain > 0) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(sa * spec.skinRatio * 1.06, at);
      osc.frequency.exponentialRampToValueAtTime(sa * spec.skinRatio, at + 0.03);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(spec.skinGain * gain, at + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + spec.skinDecay);
      osc.connect(g);
      g.connect(dest);
      osc.start(at);
      osc.stop(at + spec.skinDecay + 0.02);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = spec.noiseHz;
    f.Q.value = spec.noiseQ;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(spec.noiseGain * gain, at + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, at + spec.noiseDecay);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(at);
    src.stop(at + spec.noiseDecay + 0.02);
  }

  /** A plucked string from the bank. */
  pluck(at: number, degree: number, seconds: number, gain = 1, dest = this.partGain.pluck, attack = 0.002): void {
    const idx = Math.min(this.bank.length - 1, Math.max(0, degree - BANK_LOW));
    const buffer = this.bank[idx];
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    // Fine-tune for degrees outside the bank so the ostinato does not silently
    // flatten out at the top of its range.
    const wanted = ragaHz(this.theme.raga, this.theme.sa, degree);
    const built = ragaHz(this.theme.raga, this.theme.sa, idx + BANK_LOW);
    src.playbackRate.value = wanted / built;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    // Let the string ring past its written length rather than cutting it: a
    // damped-off pluck reads as a mute, which is a different articulation.
    const tail = Math.max(0.25, seconds * 1.35);
    g.gain.setTargetAtTime(0.0001, at + tail * 0.5, tail * 0.35);
    src.connect(g);
    g.connect(dest);
    src.start(at);
    src.stop(at + Math.min(buffer.duration / src.playbackRate.value, tail + 0.6));
  }

  /** A bansuri-like flute note, with vibrato and optional meend. */
  flute(at: number, degree: number, seconds: number, gain = 1, from?: number): void {
    const hz = ragaHz(this.theme.raga, this.theme.sa, degree + 5);
    const dest = this.partGain.flute;
    const dur = Math.max(0.12, seconds * 0.92);
    const attack = Math.min(0.09, dur * 0.3);

    const body = this.ctx.createGain();
    body.gain.setValueAtTime(0.0001, at);
    body.gain.linearRampToValueAtTime(gain * 0.5, at + attack);
    body.gain.setValueAtTime(gain * 0.5, at + dur * 0.7);
    body.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    body.connect(dest);

    // Vibrato, faded in. A bansuri player does not start a note with vibrato
    // already at depth, and one that does sounds like a theremin.
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.4;
    const lfoDepth = this.ctx.createGain();
    lfoDepth.gain.setValueAtTime(0, at);
    lfoDepth.gain.linearRampToValueAtTime(hz * 0.008, at + Math.min(0.35, dur * 0.6));
    lfo.connect(lfoDepth);
    lfo.start(at);
    lfo.stop(at + dur + 0.05);

    const partials: [number, number][] = [[1, 1], [2, 0.14], [3, 0.05]];
    for (const [mult, level] of partials) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      if (from !== undefined) {
        const fromHz = ragaHz(this.theme.raga, this.theme.sa, from + 5);
        osc.frequency.setValueAtTime(fromHz * mult, at);
        // Meend over a third of the note: long enough to hear as a slide, short
        // enough that the note still lands on its own pitch.
        osc.frequency.exponentialRampToValueAtTime(hz * mult, at + Math.min(0.22, dur * 0.34));
      } else {
        osc.frequency.setValueAtTime(hz * mult, at);
      }
      lfoDepth.connect(osc.frequency);
      const g = this.ctx.createGain();
      g.gain.value = level;
      osc.connect(g);
      g.connect(body);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }

    // Breath. Without it the flute is a sine and reads as a test tone.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(hz * 1.8, at);
    bp.Q.value = 1.6;
    const bg = this.ctx.createGain();
    bg.gain.setValueAtTime(0.0001, at);
    // The chiff: breath is loudest at the very start of a blown note.
    bg.gain.linearRampToValueAtTime(gain * 0.22, at + 0.03);
    bg.gain.exponentialRampToValueAtTime(gain * 0.05, at + Math.min(0.3, dur));
    bg.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp);
    bp.connect(bg);
    bg.connect(dest);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  // --- control -------------------------------------------------------------

  setPartMuted(part: Part, muted: boolean): void {
    this.mute[part] = muted;
  }

  soloTabla(): void {
    this.mute.drone = true;
    this.mute.pluck = true;
    this.mute.flute = true;
    this.mute.tabla = false;
  }

  setLevel(level: number, at = this.ctx.currentTime, seconds = 0.5): void {
    this.bus.gain.setTargetAtTime(Math.max(0.0001, level), at, Math.max(0.01, seconds / 3));
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      for (const o of this.droneOscs) o.stop();
    } catch {
      // Never started, or already stopped. Neither matters at teardown.
    }
    this.bus.disconnect();
  }
}
