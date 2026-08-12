/**
 * The melodic material for the cup themes.
 *
 * The game is set across India and the music is written from a raga's note set
 * rather than a Western major or minor scale. A raga is far more than a scale —
 * it carries characteristic phrases, ornaments, a time of day and a set of
 * notes you lean on and notes you only pass through — and nothing here claims
 * to be a performance. What it does claim is that the pitch material is drawn
 * from a named raga's swaras, that the phrases move by its own aroha/avaroha
 * rather than by Western voice leading, and that the vadi is where the lines
 * come to rest. That is honest: it is raga-derived, not raga.
 *
 * Degrees are semitone offsets from Sa. Sa itself is a movable tonic — the
 * whole system is relative — so the Hz is stored per theme, not per raga.
 */

export interface Raga {
  id: string;
  /** Common transliterated name. */
  name: string;
  /**
   * Semitone offsets from Sa, ascending. Both ragas used here are the same set
   * in aroha and avaroha, which is why one array is enough; a raga with a
   * different descent (Bhairavi's or Kafi's vakra forms) would need two and the
   * phrase writer would have to pick by direction.
   */
  degrees: readonly number[];
  /** Sargam names of `degrees`, so the note set is legible in the source. */
  swaras: readonly string[];
  /** Index into `degrees` of the vadi — the raga's most emphasised note. */
  vadi: number;
  /** Index of the samvadi, the second most emphasised. */
  samvadi: number;
  /** One line on what the raga is for, and where it is used here. */
  note: string;
}

/**
 * **Raga Bhupali (Bhoop)** — a pentatonic (audava) raga of the Kalyan thaat.
 *
 * Note set: **S R G P D** — with Sa = C that is **C D E G A**. Ma and Ni are
 * both omitted entirely, in ascent and descent; that omission is the raga, and
 * putting an F or a B anywhere in a Bhupali phrase is the mistake to avoid.
 * Vadi Ga, samvadi Dha. Traditionally an early-evening raga, open and buoyant —
 * which is why it is on the fast, bright cup.
 */
export const BHUPALI: Raga = {
  id: 'bhupali',
  name: 'Bhupali (Bhoop)',
  degrees: [0, 2, 4, 7, 9],
  swaras: ['S', 'R', 'G', 'P', 'D'],
  vadi: 2, // Ga
  samvadi: 4, // Dha
  note: 'Pentatonic, no Ma and no Ni. Open and buoyant; used for the Copper cup.',
};

/**
 * **Raga Charukeshi** — a sampurna (seven-note) raga borrowed into Hindustani
 * practice from the Carnatic 26th melakarta.
 *
 * Note set: **S R G m P d n** — with Sa = C that is **C D E F G A♭ B♭**. The
 * lower tetrachord is major and the upper is minor, and that split is the whole
 * character: it turns bittersweet exactly halfway up the scale. Vadi Pa,
 * samvadi Sa. Used for the slower, dusk-lit cup.
 */
export const CHARUKESHI: Raga = {
  id: 'charukeshi',
  name: 'Charukeshi',
  degrees: [0, 2, 4, 5, 7, 8, 10],
  swaras: ['S', 'R', 'G', 'm', 'P', 'd', 'n'],
  vadi: 4, // Pa
  samvadi: 0, // Sa
  note: 'Major below, minor above. Bittersweet; used for the Lantern cup.',
};

export const RAGAS: readonly Raga[] = [BHUPALI, CHARUKESHI];

/**
 * Hz for a scale degree. `degree` indexes the raga's own note set and is free to
 * run negative or past the end — it wraps by octaves, so `-1` is the note below
 * Sa (mandra) and `degrees.length` is the Sa above. Writing phrases against the
 * raga's degrees rather than against semitones is what keeps an accidental out
 * of the melody by construction.
 */
export function ragaHz(raga: Raga, sa: number, degree: number): number {
  const n = raga.degrees.length;
  const octave = Math.floor(degree / n);
  const step = degree - octave * n;
  return sa * Math.pow(2, (raga.degrees[step]! + 12 * octave) / 12);
}
