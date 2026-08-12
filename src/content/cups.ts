import type { CupSpec, TrackSpec } from '../core/contracts.ts';
import { TRACKS, trackById } from './tracks/index.ts';

/**
 * The two cups.
 *
 * Content only (ARCHITECTURE.md §2: `content/*` owns data and contains no
 * behaviour). The cup names are the cast's, not the country's — these are
 * medical students who have blocked out a weekend between rotations, and the
 * joke stays in the naming rather than in the tracks.
 *
 * Running order inside each cup is deliberate and is the one design decision
 * this file makes:
 *
 *  - **Rotation Cup** opens on the widest, flattest track in the game and closes
 *    on the narrowest. Kayal Causeway teaches that width is a resource, Jharokha
 *    Bazaar takes it away in the arcade, Sundown Sands gives it back in exchange
 *    for one enormous commitment, and Seawall Squall spends the whole lap
 *    proving there is no safe side.
 *  - **Finals Cup** opens on elevation, removes the walls, removes the sweeping
 *    corners, and finishes on the only jump in the game that decides a race.
 *    Each track subtracts one thing the player has learned to lean on.
 */

export const ROTATION_CUP: CupSpec = {
  id: 'rotation-cup',
  name: 'Rotation Cup',
  blurb: 'Four places, one weekend, nobody has slept.',
  trackIds: ['kayal-causeway', 'jharokha-bazaar', 'sundown-sands', 'seawall-squall'],
};

export const FINALS_CUP: CupSpec = {
  id: 'finals-cup',
  name: 'Finals Cup',
  blurb: 'Everything you were leaning on, taken away one track at a time.',
  trackIds: ['stonestep-ghats', 'saltpan-mirage', 'nightshift-circuit', 'snowline-pass'],
};

export const CUPS: CupSpec[] = [ROTATION_CUP, FINALS_CUP];

export function cupById(id: string): CupSpec {
  const c = CUPS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown cup "${id}"`);
  return c;
}

/** The cup's tracks, resolved. Throws on an id that is not in `TRACKS`, which
 *  is the point: a typo in a cup is a boot failure, not a short cup. */
export function cupTracks(cup: CupSpec): TrackSpec[] {
  return cup.trackIds.map(trackById);
}

/**
 * Every track must belong to exactly one cup. Checked at module load rather
 * than left as a comment, because the failure mode — a track that exists, passes
 * the validator and is unreachable from any menu — is invisible.
 */
const seen = new Set<string>();
for (const cup of CUPS) {
  for (const id of cup.trackIds) {
    if (seen.has(id)) throw new Error(`content/cups: track "${id}" appears in two cups`);
    seen.add(id);
    trackById(id);
  }
}
for (const t of TRACKS) {
  if (!seen.has(t.id)) throw new Error(`content/cups: track "${t.id}" is in no cup`);
}
