import { CONFIG } from '../core/config.ts';
import { SurfaceKind, WallKind } from '../core/contracts.ts';
import { clamp } from '../core/mathx.ts';
import { blankSample, type TrackSurface } from '../track/surface.ts';
import type { Kart } from './kart.ts';

/**
 * Collision: walls, kart-to-kart, and out-of-bounds recovery.
 *
 * ============ BUG CLASS 1: TUNNELLING ============
 * At 24.5 m/s a kart covers 0.41 m per 60 Hz frame, which is enough to step
 * straight over a thin wall. This code does not have that problem, and the
 * reason is worth stating because it is a property of the architecture rather
 * than of a clever test:
 *
 * **Walls are half-planes in track space, not objects in world space.** A
 * barrier is "everything with |lateral| greater than this", so the test is a
 * comparison on a continuous quantity that the kart cannot skip over. There is
 * no thin slab to miss and no ray to fire. The position clamp *is* the swept
 * result, exactly, at any speed.
 *
 * The remaining tunnelling risk is a station whose wall begins mid-corner while
 * the kart is already outside its line — driving around the *end* of a wall.
 * That is handled by testing the barrier at the kart's current station every
 * step, so the wall catches it the moment the station's wall kind changes.
 *
 * ============ BUG CLASS 2: STICKY WALLS ============
 * The naive response — cancel the velocity component into the wall and stop —
 * glues the kart to the barrier: every subsequent step re-detects the overlap
 * and re-cancels. Three things prevent it here: only the *normal* component is
 * killed, the tangential component is preserved almost intact (0.94), and the
 * kart is pushed clear by a small separation each step so the next step starts
 * outside the overlap rather than inside it.
 */

const K = CONFIG.kart;
const SAMPLE = blankSample();

export interface WallHit {
  kart: Kart;
  /** Impact speed along the wall normal, m/s. Drives the FX and the audio. */
  normalSpeed: number;
  u: number;
}

export interface KartHit {
  a: Kart;
  b: Kart;
  /** Closing speed along the line of centres. */
  closingSpeed: number;
  /** The kart that came off worse, if either spun. */
  spun: Kart | null;
}

/**
 * Resolve the barrier for one kart. Returns a hit when contact happened, so
 * that the caller can play a sound and shake the camera — the physics is
 * complete without it.
 */
export function resolveWalls(kart: Kart, surface: TrackSurface): WallHit | null {
  surface.sample(kart.x, kart.z, SAMPLE, kart.hintU);
  const station = surface.stationAt(SAMPLE.u);
  if (station.wall === WallKind.Open) return null;

  const wallOffset = station.halfWidth + CONFIG.track.vergeWidth;
  const limit = wallOffset - K.collision.radius;
  const lateral = SAMPLE.lateral;
  if (Math.abs(lateral) <= limit) return null;

  const side = Math.sign(lateral);
  // Wall normal points back toward the centre of the track.
  const nx = -station.rx * side;
  const nz = -station.rz * side;

  // Push out to the limit plus a small separation. Without the separation the
  // kart rests exactly on the boundary and re-collides every single step, which
  // is one of the two things that makes a wall sticky.
  const penetration = Math.abs(lateral) - limit;
  const push = penetration + K.collision.separation;
  kart.x += nx * push;
  kart.z += nz * push;

  const vn = kart.vx * nx + kart.vz * nz;
  if (vn >= 0) {
    // Already moving away — the overlap was positional, not a fresh impact.
    return null;
  }

  // Split into normal and tangential, kill only the normal.
  const tx = kart.vx - vn * nx;
  const tz = kart.vz - vn * nz;
  const keep = K.collision.wallTangentKeep;
  kart.vx = tx * keep + nx * (-vn * K.collision.wallRestitution);
  kart.vz = tz * keep + nz * (-vn * K.collision.wallRestitution);

  // A scrape should not also be a spin. Only a genuinely square hit unsettles
  // the kart, and even then it is yaw disturbance rather than a spin-out.
  const impact = -vn;
  if (impact > 6.0) {
    kart.yawRate += side * Math.min(2.4, impact * 0.12);
    kart.cancelDrift();
  }

  return { kart, normalSpeed: impact, u: SAMPLE.u };
}

/**
 * Kart-to-kart contact, resolved as an equal-and-opposite impulse along the
 * line of centres, weighted by mass.
 *
 * Weight is what decides who wins, and the roster's weight stat is a real
 * multiplier on mass rather than a label — so a lightweight genuinely loses
 * contact battles, which is the trade the roster is offering.
 */
export function resolveKartPair(a: Kart, b: Kart): KartHit | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const distSq = dx * dx + dz * dz;
  const minDist = K.collision.radius * 2;
  if (distSq >= minDist * minDist || distSq < 1e-9) return null;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const nz = dz / dist;

  // Positional separation first, split by inverse mass so the heavier kart
  // barely moves. Doing this before the impulse stops two karts that are
  // already overlapping from trading impulses forever without separating.
  const overlap = minDist - dist;
  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const invSum = invA + invB;
  a.x -= nx * overlap * (invA / invSum);
  a.z -= nz * overlap * (invA / invSum);
  b.x += nx * overlap * (invB / invSum);
  b.z += nz * overlap * (invB / invSum);

  const rvx = b.vx - a.vx;
  const rvz = b.vz - a.vz;
  const closing = -(rvx * nx + rvz * nz);
  if (closing <= 0) return { a, b, closingSpeed: 0, spun: null };

  // Restitution is low: karts bumping should nudge each other off line, not
  // bounce apart like billiards.
  const j = (closing * (1 + 0.25)) / invSum;
  const impulse = Math.min(j, K.collision.kartImpulse);
  a.vx -= nx * impulse * invA;
  a.vz -= nz * impulse * invA;
  b.vx += nx * impulse * invB;
  b.vz += nz * impulse * invB;

  // A hard hit spins the lighter kart. Equal masses: neither spins, because a
  // coin-flip spin between two identical karts reads as the game picking a
  // loser at random.
  let spun: Kart | null = null;
  if (closing > K.collision.spinThreshold) {
    const ratio = a.mass / b.mass;
    if (ratio > 1.12) spun = b;
    else if (ratio < 0.89) spun = a;
    if (spun && !spun.spinOut()) spun = null;
  } else if (closing > K.collision.spinThreshold * 0.55) {
    // A moderate hit is yaw disturbance only — enough to lose the corner, not
    // enough to lose the race.
    a.yawRate -= closing * 0.05 * (a.mass > b.mass ? 0.5 : 1);
    b.yawRate += closing * 0.05 * (b.mass > a.mass ? 0.5 : 1);
  }

  return { a, b, closingSpeed: closing, spun };
}

/**
 * ============ BUG CLASS 5: RESPAWN FACING BACKWARDS ============
 *
 * Recovery puts the kart on the racing line, **facing along the track
 * tangent**, at a sane speed. The heading comes from the station's tangent, not
 * from the kart's own heading, not from its velocity, and not from the
 * direction it was last travelling — all three of which are wrong precisely
 * when recovery is needed, because the kart is usually spinning.
 */
export function respawn(kart: Kart, surface: TrackSurface): void {
  surface.sample(kart.x, kart.z, SAMPLE, kart.hintU);
  // Back up slightly along the track so the kart is not dropped on top of
  // whatever it just failed to negotiate.
  const u = SAMPLE.u - 3.0;
  const station = surface.stationAt(u);

  // Lateral: keep the side the kart went off, clamped inside the road, so a
  // recovery does not teleport across the track in front of a rival.
  const lateral = clamp(SAMPLE.lateral, -station.halfWidth * 0.55, station.halfWidth * 0.55);

  const p = { x: 0, y: 0, z: 0 };
  surface.pointAt(u, lateral, p);

  // Heading from the tangent. Note the horizontal projection: on a descent the
  // tangent has a real y component and using it directly points the kart into
  // the road.
  const heading = Math.atan2(station.tx, station.tz);

  const speed = Math.min(K.respawn.maxSpeed, kart.speed * K.respawn.speedKeep);
  kart.placeAt(p.x, p.y + K.respawn.lift, p.z, heading, speed);
  kart.invulnerable = K.respawn.invulnerability;
  kart.offTrackTimer = 0;
  kart.respawns++;
}

/** True when the kart has been off the corridor long enough to need recovery,
 *  or has fallen far enough below the surface that nothing else will save it. */
export function needsRespawn(kart: Kart): boolean {
  if (kart.offTrackTimer >= K.respawn.graceSeconds) return true;
  // A kart 25 m below the road has left through the geometry somehow. Recover
  // rather than let it fall forever.
  if (kart.y < kart.sample.height - 25) return true;
  return false;
}

/** Surface kinds that count as "off the road" for the recovery timer. Kerbs do
 *  not: a wide kerb-hopping line is a racing line, not a mistake. */
export function isOffRoad(surface: SurfaceKind): boolean {
  return surface === SurfaceKind.Void;
}
