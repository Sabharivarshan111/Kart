import type { DriverSpec } from '../core/contracts.ts';

/**
 * The roster: eight medical students who have blocked out a weekend between
 * rotations and taken it far too seriously.
 *
 * Stats are real multipliers in `vehicle/kart.ts`, not labels on a menu.
 * `weight` decides who wins a collision and is a genuine mass multiplier, so a
 * lightweight really does lose contact battles. That is the price of the
 * cornering, and it has to be felt or the roster is decoration.
 *
 * No stat total is constant. "Balanced" is one of the choices on offer, not the
 * baseline everyone else is a rearrangement of.
 *
 * On the cast: the names are invented, drawn from across regions and
 * communities, and nobody here is a caricature of where they are from. The
 * medical-student joke lives in the blurbs and the rotations — sleep debt,
 * ward-round humour, the coffee — and never in anything clinical, never a real
 * patient, and never a real institution.
 */
export const ROSTER: DriverSpec[] = [
  {
    id: 'ananya',
    name: 'Ananya Rao',
    rotation: 'General Medicine',
    blurb: 'Takes notes on her own laps. Colour-codes them.',
    topSpeed: 0.55,
    acceleration: 0.55,
    handling: 0.55,
    weight: 0.5,
    colourKey: 'cobalt',
    ai: { skill: 0.82, aggression: 0.5, sloppiness: 1.4 },
  },
  {
    id: 'meera',
    name: 'Meera Solanki',
    rotation: 'Paediatrics',
    // The lightest kart on the grid: turns in beautifully and gets shoved off
    // the road by anyone who fancies it.
    blurb: 'Fastest hands in the year. Weighs nothing. Both are a problem.',
    topSpeed: 0.3,
    acceleration: 0.9,
    handling: 0.95,
    weight: 0.12,
    colourKey: 'lime',
    ai: { skill: 0.78, aggression: 0.35, sloppiness: 2.1 },
  },
  {
    id: 'ibrahim',
    name: 'Ibrahim Qureshi',
    rotation: 'Orthopaedics',
    // The opposite trade: unstoppable in a straight line and in a crowd,
    // hopeless anywhere that requires turning.
    blurb: 'Believes every corner is a straight that has given up.',
    topSpeed: 0.95,
    acceleration: 0.25,
    handling: 0.2,
    weight: 0.95,
    colourKey: 'ember',
    ai: { skill: 0.74, aggression: 0.85, sloppiness: 2.6 },
  },
  {
    id: 'devika',
    name: 'Devika Menon',
    rotation: 'Anaesthetics',
    blurb: 'Calm to the point of being unsettling. Never misses an apex.',
    topSpeed: 0.45,
    acceleration: 0.6,
    handling: 0.9,
    weight: 0.35,
    colourKey: 'teal',
    ai: { skill: 0.9, aggression: 0.45, sloppiness: 0.9 },
  },
  {
    id: 'tenzin',
    name: 'Tenzin Norbu',
    rotation: 'Emergency',
    blurb: 'Off the line before the lights finish. Sleeps in four-hour blocks.',
    topSpeed: 0.4,
    acceleration: 0.95,
    handling: 0.6,
    weight: 0.4,
    colourKey: 'amber',
    ai: { skill: 0.8, aggression: 0.62, sloppiness: 1.7 },
  },
  {
    id: 'simran',
    name: 'Simran Kaur',
    rotation: 'Cardiology',
    blurb: 'Quiet all lap, then gone down the back straight.',
    topSpeed: 0.9,
    acceleration: 0.4,
    handling: 0.5,
    weight: 0.62,
    colourKey: 'violet',
    ai: { skill: 0.86, aggression: 0.55, sloppiness: 1.2 },
  },
  {
    id: 'joseph',
    name: 'Joseph Fernandes',
    rotation: 'Surgery',
    blurb: 'Holds his line. Holds it into you, if that is where it goes.',
    topSpeed: 0.75,
    acceleration: 0.35,
    handling: 0.35,
    weight: 0.85,
    colourKey: 'slate',
    ai: { skill: 0.7, aggression: 0.95, sloppiness: 3.0 },
  },
  {
    id: 'arjun',
    name: 'Arjun Pillai',
    rotation: 'Radiology',
    blurb: 'Has seen the racing line. Describes it at length. Sometimes drives it.',
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

/** Accent colour for a driver's kart, picked as a colour three along the roster
 *  so no two karts share a body/accent pair. */
export function accentFor(driver: DriverSpec): string {
  const i = ROSTER.findIndex((d) => d.id === driver.id);
  return ROSTER[(i + 3) % ROSTER.length]!.colourKey;
}
