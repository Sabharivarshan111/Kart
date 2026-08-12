import type { TrackSpec } from '../../core/contracts.ts';
import { KAYAL_CAUSEWAY } from './kayal-causeway.ts';
import { JHAROKHA_BAZAAR } from './jharokha-bazaar.ts';
import { SUNDOWN_SANDS } from './sundown-sands.ts';
import { SEAWALL_SQUALL } from './seawall-squall.ts';
import { STONESTEP_GHATS } from './stonestep-ghats.ts';
import { SALTPAN_MIRAGE } from './saltpan-mirage.ts';
import { NIGHTSHIFT_CIRCUIT } from './nightshift-circuit.ts';
import { SNOWLINE_PASS } from './snowline-pass.ts';

/**
 * Every track, in cup order. `TRACKS[0]` is the default the game boots on and
 * the one the bug-class suite drives, so it is deliberately the widest and
 * flattest of the eight — a suite that fails because the default track is hard
 * is measuring the track, not the bug.
 */
export const TRACKS: TrackSpec[] = [
  KAYAL_CAUSEWAY,
  JHAROKHA_BAZAAR,
  SUNDOWN_SANDS,
  SEAWALL_SQUALL,
  STONESTEP_GHATS,
  SALTPAN_MIRAGE,
  NIGHTSHIFT_CIRCUIT,
  SNOWLINE_PASS,
];

export function trackById(id: string): TrackSpec {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown track "${id}"`);
  return t;
}

export {
  KAYAL_CAUSEWAY,
  JHAROKHA_BAZAAR,
  SUNDOWN_SANDS,
  SEAWALL_SQUALL,
  STONESTEP_GHATS,
  SALTPAN_MIRAGE,
  NIGHTSHIFT_CIRCUIT,
  SNOWLINE_PASS,
};
