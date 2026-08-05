import type { TrackSpec } from '../../core/contracts.ts';
import { COPPER_FLATS } from './copper-flats.ts';
import { LANTERN_REACH } from './lantern-reach.ts';

export const TRACKS: TrackSpec[] = [COPPER_FLATS, LANTERN_REACH];

export function trackById(id: string): TrackSpec {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown track "${id}"`);
  return t;
}

export { COPPER_FLATS, LANTERN_REACH };
