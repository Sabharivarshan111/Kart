import { defineTheme, type Theme } from '../core/palette.ts';

/**
 * Track themes. Every colour in the game comes from here or from
 * `core/palette.ts` — there is no colour literal anywhere else in `src/`.
 *
 * `defineTheme` runs `assertShadeable` at module load, which checks each
 * colour's luminance **after** the darkest cel band multiplies it. That is bug
 * class 8, caught at import time rather than at screenshot time: a colour that
 * looks convincingly dark in a swatch renders as pure black once shaded.
 * The validator repeats the check at each track's own sun elevation.
 */

export const COPPER: Theme = defineTheme({
  name: 'copper',
  skyTop: 0x2e4a7d,
  skyHorizon: 0xf0a35e,
  scenery: 0x9a5f3a,
  sceneryAlt: 0xc98a52,
  road: 0x4a4f5e,
  kerbA: 0xe8e3d8,
  kerbB: 0xd2593f,
  grass: 0x6f7a45,
  sand: 0xd9b276,
  boostStrip: 0x3fc8e0,
  wall: 0x8a6a4e,
  wallAccent: 0xe8e3d8,
  ink: 0x1a1d26,
  sun: 0xfff0d4,
  ambient: 0x6a7a9c,
  // 0.44: the darkest band still separates from the ink outline on an OLED
  // panel at low brightness. Below ~0.35 the road and its own outline merge.
  ambientLevel: 0.44,
  fog: 0xe8b884,
  fogDensity: 0.0035,
});

export const LANTERN: Theme = defineTheme({
  name: 'lantern',
  skyTop: 0x1c2340,
  skyHorizon: 0x4a3f6b,
  scenery: 0x6b5f8a,
  sceneryAlt: 0x8a7fae,
  road: 0x4d5266,
  kerbA: 0xf2ead9,
  kerbB: 0x8e4fd0,
  grass: 0x556b52,
  sand: 0xbfa77e,
  boostStrip: 0x54e3c2,
  wall: 0x7a6f96,
  wallAccent: 0xffd98a,
  ink: 0x14161f,
  sun: 0xffe6b8,
  ambient: 0x7c86b8,
  // Higher than copper because this track spends a third of its lap in a
  // tunnel with a low sun; at 0.44 the tunnel interior went to solid black.
  ambientLevel: 0.52,
  fog: 0x3a3558,
  fogDensity: 0.006,
});

export const SALTMARSH: Theme = defineTheme({
  name: 'saltmarsh',
  skyTop: 0x5b8fc4,
  skyHorizon: 0xd8e6ea,
  scenery: 0x8fa8a0,
  sceneryAlt: 0xb9cbc2,
  road: 0x565c66,
  kerbA: 0xf4f7f5,
  kerbB: 0x3f7fa8,
  grass: 0x7b8f62,
  sand: 0xcfc39a,
  boostStrip: 0x46d6a8,
  wall: 0x93a3a8,
  wallAccent: 0xf4f7f5,
  ink: 0x1b2229,
  sun: 0xf6fbff,
  ambient: 0x9fb4c8,
  ambientLevel: 0.56,
  fog: 0xcfe0e6,
  fogDensity: 0.0045,
});

export const UMBER: Theme = defineTheme({
  name: 'umber',
  skyTop: 0x3a2a48,
  skyHorizon: 0xd97a5a,
  scenery: 0x7a4a48,
  sceneryAlt: 0xa8705e,
  road: 0x51495a,
  kerbA: 0xf0e2d0,
  kerbB: 0xc4553f,
  grass: 0x6a7048,
  sand: 0xc9a173,
  boostStrip: 0x59d4e8,
  wall: 0x8a6560,
  wallAccent: 0xf0e2d0,
  ink: 0x1a151f,
  sun: 0xffdcb4,
  ambient: 0x7a6a9a,
  // The sun sits at 16° on this track. That puts most of the road surface in
  // the bottom band, so the ambient floor has to carry it.
  ambientLevel: 0.5,
  fog: 0xc98a6e,
  fogDensity: 0.005,
});

export const ARENA: Theme = defineTheme({
  name: 'arena',
  skyTop: 0x232b45,
  skyHorizon: 0x4d5a86,
  scenery: 0x59628a,
  sceneryAlt: 0x7c86b0,
  road: 0x525872,
  kerbA: 0xf2f4fa,
  kerbB: 0xe0603f,
  grass: 0x646e52,
  sand: 0xc2ae82,
  boostStrip: 0x4fe0c8,
  wall: 0x767f9e,
  wallAccent: 0xffc23d,
  ink: 0x151824,
  sun: 0xfff4e0,
  ambient: 0x8892c0,
  ambientLevel: 0.54,
  fog: 0x3d4668,
  fogDensity: 0.0035,
});

export const THEME_LIST: Theme[] = [COPPER, LANTERN, SALTMARSH, UMBER, ARENA];
