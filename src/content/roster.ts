import type { DriverSpec } from '../core/contracts.ts';

/**
 * The roster. Eight drivers with honest trade-offs — the stats are real
 * multipliers in `vehicle/kart.ts`, not labels on a menu.
 *
 * `weight` decides who wins a collision, and it is a genuine mass multiplier,
 * so a lightweight really does lose contact battles. That is the price of the
 * cornering, and it has to be felt or the roster is decoration.
 *
 * No stat total is constant. "Balanced" is one of the choices on offer, not the
 * baseline everyone is a rearrangement of.
 */
export const ROSTER: DriverSpec[] = [
  {
    id: 'voss',
    name: 'Halcyon Voss',
    topSpeed: 0.55,
    acceleration: 0.55,
    handling: 0.55,
    weight: 0.5,
    colourKey: 'cobalt',
    ai: { skill: 0.82, aggression: 0.5, sloppiness: 1.4 },
  },
  {
    id: 'pip',
    name: 'Pip Marlowe',
    // The lightest kart on the grid: turns in beautifully and gets shoved off
    // the road by anyone who wants to.
    topSpeed: 0.3,
    acceleration: 0.9,
    handling: 0.95,
    weight: 0.12,
    colourKey: 'lime',
    ai: { skill: 0.78, aggression: 0.35, sloppiness: 2.1 },
  },
  {
    id: 'bruk',
    name: 'Bruk Odell',
    // The opposite trade: unstoppable in a straight line and in a crowd,
    // hopeless anywhere that requires turning.
    topSpeed: 0.95,
    acceleration: 0.25,
    handling: 0.2,
    weight: 0.95,
    colourKey: 'ember',
    ai: { skill: 0.74, aggression: 0.85, sloppiness: 2.6 },
  },
  {
    id: 'nia',
    name: 'Nia Sarkar',
    topSpeed: 0.45,
    acceleration: 0.6,
    handling: 0.9,
    weight: 0.35,
    colourKey: 'teal',
    ai: { skill: 0.9, aggression: 0.45, sloppiness: 0.9 },
  },
  {
    id: 'tovin',
    name: 'Tovin Crest',
    topSpeed: 0.4,
    acceleration: 0.95,
    handling: 0.6,
    weight: 0.4,
    colourKey: 'amber',
    ai: { skill: 0.8, aggression: 0.62, sloppiness: 1.7 },
  },
  {
    id: 'margo',
    name: 'Margo Aleyn',
    topSpeed: 0.9,
    acceleration: 0.4,
    handling: 0.5,
    weight: 0.62,
    colourKey: 'violet',
    ai: { skill: 0.86, aggression: 0.55, sloppiness: 1.2 },
  },
  {
    id: 'deacon',
    name: 'Deacon Roe',
    topSpeed: 0.75,
    acceleration: 0.35,
    handling: 0.35,
    weight: 0.85,
    colourKey: 'slate',
    ai: { skill: 0.7, aggression: 0.95, sloppiness: 3.0 },
  },
  {
    id: 'wren',
    name: 'Wren Ashby',
    topSpeed: 0.5,
    acceleration: 0.7,
    handling: 0.8,
    weight: 0.28,
    colourKey: 'rose',
    ai: { skill: 0.84, aggression: 0.4, sloppiness: 1.5 },
  },
];

export function driverById(id: string): DriverSpec {
  const d = ROSTER.find((x) => x.id === id);
  if (!d) throw new Error(`unknown driver "${id}"`);
  return d;
}

/** Accent colour for a driver's kart, picked as the next colour round the
 *  roster so no two karts share a body/accent pair. */
export function accentFor(driver: DriverSpec): string {
  const i = ROSTER.findIndex((d) => d.id === driver.id);
  return ROSTER[(i + 3) % ROSTER.length]!.colourKey;
}
