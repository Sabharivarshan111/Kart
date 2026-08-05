import type { Controls } from './contracts.ts';

/**
 * Helpers for the one control struct. The vehicle only ever moves through a
 * `Controls`, whether it came from a keyboard, a thumb or the AI — that is what
 * stops the AI from quietly cheating and what makes a race replayable.
 */

export function neutralControls(): Controls {
  return { throttle: 0, brake: 0, steer: 0, drift: false, useItem: false, lookBack: false };
}

export function copyControls(dst: Controls, src: Controls): void {
  dst.throttle = src.throttle;
  dst.brake = src.brake;
  dst.steer = src.steer;
  dst.drift = src.drift;
  dst.useItem = src.useItem;
  dst.lookBack = src.lookBack;
}

export function clearControls(c: Controls): void {
  c.throttle = 0;
  c.brake = 0;
  c.steer = 0;
  c.drift = false;
  c.useItem = false;
  c.lookBack = false;
}

/** Clamp a control struct into its declared ranges. Called once on the way into
 *  the vehicle so no producer can hand it an out-of-range steer and get more
 *  grip than the physics intends. */
export function sanitiseControls(c: Controls): void {
  c.throttle = c.throttle < 0 ? 0 : c.throttle > 1 ? 1 : c.throttle;
  c.brake = c.brake < 0 ? 0 : c.brake > 1 ? 1 : c.brake;
  c.steer = c.steer < -1 ? -1 : c.steer > 1 ? 1 : c.steer;
}
