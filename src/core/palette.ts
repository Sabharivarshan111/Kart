/**
 * THE palette (ARCHITECTURE.md §3.2). No colour literal exists anywhere else in
 * `src/` — not in a material, not in a shader default, not in a CSS string.
 *
 * Bug class 8: banded cel shading multiplies the darkest band by an ambient
 * term, so a colour that looks convincingly dark in a swatch renders as pure
 * black once shaded, especially under a low sun. Every theme colour therefore
 * passes `assertShadeable()` at construction, which checks the *shaded* darkest
 * band rather than the swatch.
 */

export type Hex = number;

/**
 * The roadside prop a theme dresses its verges with. Naming the kit here rather
 * than in the renderer keeps "what this place looks like" in one file with the
 * colours it looks like it in: a Kerala backwater and a Himalayan pass have to
 * be unmistakable from a single frame (AGENT_BRIEF, cultural representation),
 * and a generic post in both makes them the same place twice.
 *
 * Each kit is built procedurally in `render/scenery.ts` from this theme's
 * `scenery`/`sceneryAlt` colours — there are no colour literals there.
 */
export const SceneryKit = {
  /** Coconut palm: leaning trunk, radial fronds. Kerala, and the coast. */
  Palm: 'palm',
  /** Carved sandstone screen pillar with a domed chhatri cap. Jaipur. */
  Jali: 'jali',
  /** Shack parasol on a driftwood pole. Goa. */
  Parasol: 'parasol',
  /** Sea-wall lighting mast with a crossarm. Mumbai. */
  Mast: 'mast',
  /** Stone lamp column on a stepped plinth. Varanasi ghats. */
  GhatLamp: 'ghat-lamp',
  /** Stacked salt block cairn. Rann of Kutch. */
  Cairn: 'cairn',
  /** Neon sign pylon on a gantry leg. Bengaluru at night. */
  Pylon: 'pylon',
  /** Conical deodar pine under snow. Himalayan pass. */
  Pine: 'pine',
} as const;
export type SceneryKit = (typeof SceneryKit)[keyof typeof SceneryKit];

export interface Theme {
  name: string;
  /** Sky gradient, top to horizon. */
  skyTop: Hex;
  skyHorizon: Hex;
  /** Distant band under the horizon — hills, dunes, city, whatever the track
   *  builds out of it. */
  scenery: Hex;
  sceneryAlt: Hex;
  /** Which roadside prop this place is dressed with. */
  sceneryKit: SceneryKit;
  road: Hex;
  kerbA: Hex;
  kerbB: Hex;
  grass: Hex;
  sand: Hex;
  boostStrip: Hex;
  wall: Hex;
  wallAccent: Hex;
  /** Line colour for outlines and Sobel edges. */
  ink: Hex;
  /** Directional light and ambient. The ambient term is what decides whether
   *  the darkest cel band survives — see assertShadeable. */
  sun: Hex;
  ambient: Hex;
  /** 0..1 ambient intensity used by the cel ramp's darkest band. */
  ambientLevel: number;
  fog: Hex;
  fogDensity: number;
}

/** Kart body colours, kept readable against every theme's road. */
export const KART_COLOURS: Record<string, Hex> = {
  ember: 0xff6a3d,
  cobalt: 0x3f7bff,
  lime: 0x86e04a,
  violet: 0xa768ff,
  amber: 0xffc23d,
  teal: 0x2fd8c4,
  rose: 0xff7bb0,
  slate: 0x9aa8bd,
};

/** Fixed colours that do not vary by theme. */
export const COMMON = {
  tyre: 0x2b2f3a,
  rim: 0xd8dee9,
  chrome: 0xc6cedd,
  glass: 0x8fc9ff,
  driverSkinA: 0xf0c9a4,
  driverSkinB: 0xb07a4e,
  driverSkinC: 0x74492e,
  visor: 0x1b2331,
} as const;

export const UI = {
  ink: '#f2f5fb',
  inkDim: '#9aa8bd',
  panel: '#121826',
  panelEdge: '#2a3450',
  accent: '#ffc23d',
  accentAlt: '#2fd8c4',
  danger: '#ff5b5b',
  good: '#86e04a',
  shadow: 'rgba(4, 7, 14, 0.55)',
  /** Near-opaque ink for text contours. Sits under every HUD glyph so the
   *  readout survives a white salt flat and a night circuit alike. */
  contour: 'rgba(6, 9, 16, 0.92)',
  backdrop: '#0b0f1a',
} as const;

/** Drift tier colours — the escalation has to be unmistakable at a glance. */
export const DRIFT_TIER_COLOURS: Hex[] = [0x000000, 0x4fb3ff, 0xffb43d, 0xff4fd8];

const THEMES: Record<string, Theme> = {};

export function defineTheme(t: Theme): Theme {
  assertShadeable(t);
  THEMES[t.name] = t;
  return t;
}

export function theme(name: string): Theme {
  const t = THEMES[name];
  if (!t) throw new Error(`palette: unknown theme "${name}"`);
  return t;
}

export function allThemes(): Theme[] {
  return Object.values(THEMES);
}

/** sRGB relative luminance, 0..1. */
export function luminance(hex: Hex): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The luminance a colour actually renders at in the *darkest* cel band, which
 * is base × ambientLevel. Bug class 8 is discovering this at screenshot time.
 */
export function shadedFloorLuminance(hex: Hex, ambientLevel: number): number {
  return luminance(hex) * ambientLevel;
}

/** Minimum shaded-floor luminance for a surface to still read as a colour and
 *  not as a hole in the screen. Measured by eye against the ink colour on an
 *  OLED phone at low brightness; below ~0.012 the darkest band and the outline
 *  became indistinguishable. */
export const MIN_SHADED_LUMINANCE = 0.012;

export function assertShadeable(t: Theme): void {
  const checked: [string, Hex][] = [
    ['road', t.road],
    ['grass', t.grass],
    ['sand', t.sand],
    ['wall', t.wall],
    ['scenery', t.scenery],
    ['sceneryAlt', t.sceneryAlt],
    ['kerbA', t.kerbA],
    ['kerbB', t.kerbB],
  ];
  const bad = checked.filter(
    ([, hex]) => shadedFloorLuminance(hex, t.ambientLevel) < MIN_SHADED_LUMINANCE,
  );
  if (bad.length) {
    throw new Error(
      `palette: theme "${t.name}" collapses to black in the darkest cel band: ` +
        bad
          .map(
            ([k, hex]) =>
              `${k}=#${hex.toString(16).padStart(6, '0')} ` +
              `(shaded ${shadedFloorLuminance(hex, t.ambientLevel).toFixed(4)} < ${MIN_SHADED_LUMINANCE})`,
          )
          .join(', '),
    );
  }
}
