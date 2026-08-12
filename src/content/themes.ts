import { defineTheme, SceneryKit, type Theme } from '../core/palette.ts';

/**
 * Track themes — one per track, eight places across India.
 *
 * Every colour in the game comes from here or from `core/palette.ts` — there is
 * no colour literal anywhere else in `src/`.
 *
 * `defineTheme` runs `assertShadeable` at module load, which checks each
 * colour's luminance **after** the darkest cel band multiplies it. That is bug
 * class 8, caught at import time rather than at screenshot time: a colour that
 * looks convincingly dark in a swatch renders as pure black once shaded.
 * The validator repeats the check at each track's own sun elevation.
 *
 * The relation that matters when editing any of these: the shader's darkest
 * band is `ambientLevel` flat, and the theme check computes the band from
 * `sin(sunElevation)` quantised to `celBands`. Below a sun of 14.5°,
 * `sin(el) < 1/4`, the road sits *in* the darkest band and `ambientLevel` is
 * the only thing holding it off black. That is why the three dusk/dawn/night
 * themes here (sundown 12°, ghat 9°, nightshift 7°) carry the highest ambient
 * floors in the file, and why raising the fog on them was not enough on its own
 * — fog lifts the distance, not the tarmac under the kart.
 */

/** Kerala backwaters: low green light off standing water, humid haze. */
export const KAYAL: Theme = defineTheme({
  name: 'kayal',
  skyTop: 0x5a86a0,
  skyHorizon: 0xd6e2c8,
  scenery: 0x3f6b45,
  sceneryAlt: 0x6d9a52,
  sceneryKit: SceneryKit.Palm,
  road: 0x4e5a52,
  kerbA: 0xf1f4e6,
  kerbB: 0xc4472f,
  grass: 0x5f8a46,
  sand: 0xcbb98a,
  boostStrip: 0x39d9c4,
  wall: 0x7d8a72,
  wallAccent: 0xf1f4e6,
  ink: 0x161e1a,
  sun: 0xfff6de,
  ambient: 0x8fb0a2,
  ambientLevel: 0.5,
  fog: 0xc9dcc4,
  // Thickest fog in the game bar the monsoon. The backwaters read as humid
  // because the far bank of the lagoon is half dissolved; at 0.003 the whole
  // lap was crisp and could have been anywhere.
  fogDensity: 0.0075,
});

/** Jaipur old city: pink sandstone under a near-vertical noon sun. */
export const JHAROKHA: Theme = defineTheme({
  name: 'jharokha',
  skyTop: 0x2f6fb5,
  skyHorizon: 0xe9c9a4,
  scenery: 0xb5634a,
  sceneryAlt: 0xe0916a,
  sceneryKit: SceneryKit.Jali,
  road: 0x6b5a55,
  kerbA: 0xf6ead6,
  kerbB: 0xd4553d,
  grass: 0x7c8348,
  sand: 0xdcb87e,
  boostStrip: 0x3ecbe0,
  wall: 0xc06a4e,
  wallAccent: 0xf6ead6,
  ink: 0x22161a,
  sun: 0xfff3d8,
  ambient: 0xb08a86,
  // Lowest ambient floor in the file, and it is allowed to be: at a 66° sun the
  // road sits in the *top* cel band, so the floor only ever shows on the north
  // faces of the arcade.
  ambientLevel: 0.46,
  fog: 0xe2b48e,
  fogDensity: 0.003,
});

/** Goa coast: low warm sun over surf and sand. */
export const SUNDOWN: Theme = defineTheme({
  name: 'sundown',
  skyTop: 0x3b3f7a,
  skyHorizon: 0xf5915c,
  scenery: 0x8a5f4a,
  sceneryAlt: 0xc98a63,
  sceneryKit: SceneryKit.Parasol,
  road: 0x5b5560,
  kerbA: 0xf7e6cf,
  kerbB: 0xd85a4a,
  grass: 0x74784a,
  sand: 0xe0c393,
  boostStrip: 0x4fe0d0,
  wall: 0x9a7060,
  wallAccent: 0xf7e6cf,
  ink: 0x1d1622,
  sun: 0xffd9a8,
  ambient: 0x8a7a9e,
  // 12° sun: sin(12°) = 0.21, under the first band boundary, so every flat
  // surface on the track renders at exactly this number times its own colour.
  ambientLevel: 0.52,
  fog: 0xe89a72,
  fogDensity: 0.0055,
});

/** Mumbai monsoon: flat grey-green storm light on a soaked road. */
export const SQUALL: Theme = defineTheme({
  name: 'squall',
  skyTop: 0x3d4a52,
  skyHorizon: 0x8b9a92,
  scenery: 0x4e6a5e,
  sceneryAlt: 0x7e9a86,
  sceneryKit: SceneryKit.Mast,
  road: 0x49525c,
  kerbA: 0xe6ece8,
  kerbB: 0xc25a4a,
  grass: 0x5f7350,
  sand: 0xa8a488,
  boostStrip: 0x46e0b8,
  wall: 0x6f7a80,
  wallAccent: 0xe6ece8,
  ink: 0x131a1e,
  // Overcast is not "dark", it is *flat*: a high ambient floor with a weak sun
  // colour is what makes cloud read as cloud rather than as dusk.
  sun: 0xdfe8e4,
  ambient: 0x7f929a,
  ambientLevel: 0.58,
  fog: 0x93a5a0,
  // Rain. The densest fog in the game — the sea wall fades out at about 90 m,
  // which is what makes the corner exits feel blind.
  fogDensity: 0.0085,
});

/** Varanasi ghats: dawn mist over layered river stone. */
export const GHAT: Theme = defineTheme({
  name: 'ghat',
  skyTop: 0x3f4f86,
  skyHorizon: 0xf0c08a,
  scenery: 0x8a7256,
  sceneryAlt: 0xbfa279,
  sceneryKit: SceneryKit.GhatLamp,
  road: 0x5f5a52,
  kerbA: 0xf2e8d2,
  kerbB: 0xcf6a3a,
  grass: 0x6f7a4e,
  sand: 0xd0b68c,
  boostStrip: 0x4ad2e6,
  wall: 0x93805f,
  wallAccent: 0xf2e8d2,
  ink: 0x1b1a20,
  sun: 0xffe2b0,
  ambient: 0x9a94b0,
  // 9° sun, so this is the whole lighting model for every horizontal surface.
  ambientLevel: 0.5,
  fog: 0xd9c9b4,
  fogDensity: 0.007,
});

/** Rann of Kutch: white salt crust under an enormous sky. */
export const SALTPAN: Theme = defineTheme({
  name: 'saltpan',
  skyTop: 0x2f78c4,
  skyHorizon: 0xeef4f6,
  scenery: 0xa8b0ae,
  sceneryAlt: 0xdfe6e4,
  sceneryKit: SceneryKit.Cairn,
  road: 0x6a6f74,
  kerbA: 0xfaf9f4,
  kerbB: 0xd4573f,
  grass: 0x8d9468,
  sand: 0xeae7d8,
  boostStrip: 0x35c8e8,
  wall: 0xb9bfbb,
  wallAccent: 0xfaf9f4,
  ink: 0x1e2428,
  sun: 0xfffdf2,
  ambient: 0xc0cdd4,
  // Salt bounces light back up. A low floor here made the shadow sides of the
  // cairns read as holes punched in a white sheet.
  ambientLevel: 0.6,
  fog: 0xdfe9ec,
  // Thinnest fog in the game on purpose: the horizon has to stay hard, because
  // the flatness *is* the track.
  fogDensity: 0.0022,
});

/** Bengaluru at night: neon over wet tarmac and city glow. */
export const NIGHTSHIFT: Theme = defineTheme({
  name: 'nightshift',
  skyTop: 0x141a2e,
  skyHorizon: 0x3a2a52,
  scenery: 0x5a5478,
  sceneryAlt: 0x8a7fb4,
  sceneryKit: SceneryKit.Pylon,
  road: 0x4a4e5e,
  kerbA: 0xeceef8,
  kerbB: 0xe0407f,
  grass: 0x596b52,
  sand: 0xa89b7e,
  boostStrip: 0x4ff0d8,
  wall: 0x6b6f8c,
  wallAccent: 0xffc23d,
  ink: 0x0c0f18,
  // A 7° "sun" standing in for sodium and LED spill off the buildings, so it is
  // cool and weak rather than warm and strong.
  sun: 0xbcd0ff,
  ambient: 0x7a7ec0,
  // Highest floor in the file. Night is the case where the temptation to just
  // turn everything down produces a black rectangle with three neon signs in
  // it; the tarmac has to stay a colour.
  ambientLevel: 0.62,
  fog: 0x241f3c,
  fogDensity: 0.0075,
});

/** Himalayan pass: thin cold air, snow, deodar pine. */
export const SNOWLINE: Theme = defineTheme({
  name: 'snowline',
  skyTop: 0x1f5fb0,
  skyHorizon: 0xc8dcf0,
  scenery: 0x3f5a4a,
  sceneryAlt: 0x6f8a68,
  sceneryKit: SceneryKit.Pine,
  road: 0x585f68,
  kerbA: 0xf6fafc,
  kerbB: 0xc44a52,
  grass: 0x6a7a5c,
  // The "sand" slot is packed snow on this track — it is the loose shoulder the
  // surface table already punishes, dressed as the thing that punishes you here.
  sand: 0xe8eef2,
  boostStrip: 0x40d8f0,
  wall: 0x8a9098,
  wallAccent: 0xf6fafc,
  ink: 0x16202a,
  sun: 0xfdfbff,
  ambient: 0x9ab4d0,
  ambientLevel: 0.52,
  fog: 0xd2e2ee,
  fogDensity: 0.0038,
});

export const THEME_LIST: Theme[] = [
  KAYAL,
  JHAROKHA,
  SUNDOWN,
  SQUALL,
  GHAT,
  SALTPAN,
  NIGHTSHIFT,
  SNOWLINE,
];
