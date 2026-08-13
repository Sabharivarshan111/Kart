import { CONFIG } from '../core/config.ts';
import type { Controls, DriverSpec } from '../core/contracts.ts';
import { clamp, clamp01, loopDelta, wrapAngle, wrapLength } from '../core/mathx.ts';
import type { Rng } from '../core/rng.ts';
import type { TrackSurface } from '../track/surface.ts';
import type { Kart } from '../vehicle/kart.ts';

/**
 * The AI.
 *
 * It emits a `Controls` — **the same struct the player's thumbs produce** — and
 * the vehicle moves through exactly the same code path. That is not a stylistic
 * choice: it is what stops the AI from quietly cheating, and it is what makes
 * an AI-only race a valid test of the physics and the collision.
 *
 * ============ BUG CLASS 6: AI CUTTING THROUGH WALLS ============
 * An AI that steers to a spline target and teleports along it will corner
 * through solid geometry. This one cannot: it has no position authority at all.
 * It sets throttle, brake and steer, and the barrier code in
 * `vehicle/collision.ts` stops it exactly as it stops the player. The test that
 * proves it runs a full AI-only race and asserts no kart is ever off-road for
 * more than a second.
 *
 * ============ AND THE ONE THAT MATTERS MOST ============
 * The AI's *speed* is never rubber-banded. Every kart drives at an honest pace
 * for its skill. Catch-up lives entirely in the item distribution
 * (`race/items.ts`), because an AI that drives faster when you are ahead is a
 * cheat the player can feel, and it makes their lap times meaningless.
 */

const A = CONFIG.ai;

export interface RacingLine {
  /** Lateral offset from the centreline, per station. */
  lateral: Float64Array;
  /** Maximum speed at each station, from the line's own curvature with braking
   *  back-propagated into it. */
  speed: Float64Array;
  /** World points of the line, for the minimap and for debugging. */
  x: Float64Array;
  z: Float64Array;
  spacing: number;
  length: number;
}

/**
 * Build the racing line and its speed profile.
 *
 * The line starts as "hug the inside, proportional to how tight it is", then is
 * smoothed hard along the lap. The smoothing is what produces the classic
 * out-in-out shape for free: the line physically cannot move to the inside
 * instantly, so it starts drifting outward well before the corner and unwinds
 * after it.
 */
export function buildRacingLine(surface: TrackSurface): RacingLine {
  const stations = surface.cl.stations;
  const n = stations.length;
  const spacing = surface.cl.spacing;
  const lateral = new Float64Array(n);

  // Margin from the road edge. Slightly over half a kart's width, so the
  // racing line never puts a wheel on the verge by definition.
  const margin = CONFIG.kart.trackWidth * 0.6;

  for (let i = 0; i < n; i++) {
    const s = stations[i]!;
    // Saturates at a 40 m radius: anything tighter is "as far inside as the
    // road allows", anything wider is proportionally less.
    const tightness = clamp01(Math.abs(s.curvature) * 40);
    const inside = Math.max(0, s.halfWidth - margin);
    lateral[i] = Math.sign(s.curvature) * tightness * inside;
  }

  // Heavy closed-loop smoothing. 260 iterations measured: below ~120 the line
  // still snaps to the inside at the turn-in point and the AI saws at the
  // wheel; above ~400 it flattens into the centreline and stops being a racing
  // line at all.
  smoothClosed(lateral, 260);

  // Clamp back inside the road after smoothing — the blur can push the line
  // past the edge where a wide corner meets a narrow one.
  for (let i = 0; i < n; i++) {
    const s = stations[i]!;
    const inside = Math.max(0, s.halfWidth - margin);
    lateral[i] = clamp(lateral[i]!, -inside, inside);
  }

  // World points of the line.
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    surface.pointAt(i * spacing, lateral[i]!, p);
    x[i] = p.x;
    z[i] = p.z;
  }

  // Curvature of the *line*, not of the centreline — the whole point of a
  // racing line is that it is straighter than the road.
  const speed = new Float64Array(n);
  const maxLat = CONFIG.kart.grip.lateralPeak * 9.81;
  const span = 4;
  for (let i = 0; i < n; i++) {
    const a = (i - span + n) % n;
    const b = (i + span) % n;
    const curvature = menger(x[a]!, z[a]!, x[i]!, z[i]!, x[b]!, z[b]!);
    const radius = curvature > 1e-6 ? 1 / curvature : Infinity;
    speed[i] = Math.min(CONFIG.kart.topSpeed, Math.sqrt(maxLat * radius));
  }

  // Back-propagate braking. Two passes round the loop, because a long braking
  // zone can start before the point the first pass began at.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n - 1; k >= 0; k--) {
      const i = k % n;
      const next = (i + 1) % n;
      const reachable = Math.sqrt(speed[next]! * speed[next]! + 2 * A.brakingDecel * spacing);
      if (speed[i]! > reachable) speed[i] = reachable;
    }
  }

  return { lateral, speed, x, z, spacing, length: surface.length };
}

function smoothClosed(arr: Float64Array, iterations: number): void {
  const n = arr.length;
  if (n < 3) return;
  const buf = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      buf[i] = (arr[(i - 1 + n) % n]! + 2 * arr[i]! + arr[(i + 1) % n]!) * 0.25;
    }
    arr.set(buf);
  }
}

/** Menger curvature of three points: 4·area / (|ab|·|bc|·|ca|). */
function menger(
  ax: number, az: number,
  bx: number, bz: number,
  cx: number, cz: number,
): number {
  const area2 = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  const ab = Math.hypot(bx - ax, bz - az);
  const bc = Math.hypot(cx - bx, cz - bz);
  const ca = Math.hypot(ax - cx, az - cz);
  const denom = ab * bc * ca;
  if (denom < 1e-9) return 0;
  return (2 * area2) / denom;
}

export interface AiOptions {
  /** 0..1 global difficulty. Scales skill and item aggression; never touches
   *  the player's kart, so lap times stay comparable across settings. */
  difficulty: number;
}

export class AiDriver {
  readonly kart: Kart;
  private readonly spec: DriverSpec;
  private readonly line: RacingLine;
  private readonly surface: TrackSurface;
  private readonly rng: Rng;

  /** Lateral offset the AI is currently adding to the racing line, for
   *  overtaking and avoidance. Approached rather than snapped so a rival
   *  appearing alongside does not produce an instant swerve. */
  private deviation = 0;
  private deviationTarget = 0;

  /** Deliberate mistakes: real drivers do not drive the profile perfectly, and
   *  an AI that does is unbeatable and boring in the same breath. */
  /** Seconds spent below walking pace. A kart wedged nose-first into a barrier
   *  cannot drive out of it forwards at any throttle, and without this it sits
   *  there for the rest of the race. */
  private stuckTimer = 0;
  private reverseTimer = 0;

  private mistakeTimer = 0;
  private mistakeSteer = 0;
  private nextMistakeCheck = 0;

  private difficulty = 0.6;
  /** Provided by the item system; the AI asks rather than deciding, because
   *  whether an item is worth using depends on the item. */
  shouldUseItem: (kart: Kart) => boolean = () => false;

  constructor(
    kart: Kart,
    line: RacingLine,
    surface: TrackSurface,
    rng: Rng,
    opts: AiOptions,
  ) {
    this.kart = kart;
    this.spec = kart.driver;
    this.line = line;
    this.surface = surface;
    this.rng = rng;
    this.difficulty = opts.difficulty;
  }

  setDifficulty(d: number): void {
    this.difficulty = clamp01(d);
  }

  /** Effective skill: the driver's own skill, scaled by the difficulty
   *  setting. Never above 1 — the best AI must still be beatable by a clean
   *  human lap, or the difficulty ceiling is a wall rather than a challenge. */
  private get skill(): number {
    return clamp01(this.spec.ai.skill * (0.62 + 0.38 * this.difficulty));
  }

  drive(dt: number, out: Controls, rivals: Kart[]): void {
    const kart = this.kart;
    const speed = kart.speed;
    const u = kart.sample.u;

    // --- look-ahead --------------------------------------------------------
    // Speed-scaled: at 20 m/s the AI aims about 24 m ahead. Too short and it
    // saws at the wheel; too long and it cuts the corner it is aiming past.
    // Off the road the aim point comes in close. A target 25 m down the racing
    // line, seen from the outside barrier, is a heading error the steering
    // saturates against and never resolves; a near one is reachable.
    const lookAhead =
      (A.lookAheadBase + speed * A.lookAheadPerSpeed) * (kart.sample.onRoad ? 1 : 0.45);
    const targetU = wrapLength(u + lookAhead, this.line.length);

    // ---- wedged? ----------------------------------------------------------
    // Measured: a recovery that only ever drives forwards leaves the kart at
    // 0.0 m/s against the barrier indefinitely, because the wall cancels the
    // component into it and forward throttle has nowhere to go. Backing off and
    // re-approaching is the only thing that clears it.
    if (speed < 1.2) this.stuckTimer += dt;
    else this.stuckTimer = 0;
    if (this.stuckTimer > 1.2) {
      this.reverseTimer = 1.1;
      this.stuckTimer = 0;
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      out.throttle = 0;
      out.brake = 1;
      // Steer *away* from where the nose is pointing so reversing swings the
      // kart back toward the road rather than straight back into the wall.
      out.steer = kart.sample.lateral > 0 ? 1 : -1;
      out.drift = false;
      out.useItem = false;
      out.lookBack = false;
      return;
    }

    this.updateMistakes(dt);
    this.updateAvoidance(dt, rivals);

    const idx = Math.floor(targetU / this.line.spacing) % this.line.lateral.length;
    const baseLateral = this.line.lateral[idx]!;
    const station = this.surface.stationAt(targetU);
    const margin = CONFIG.kart.trackWidth * 0.6;
    const limit = Math.max(0, station.halfWidth - margin);
    const wantLateral = clamp(baseLateral + this.deviation, -limit, limit);

    const p = { x: 0, y: 0, z: 0 };
    this.surface.pointAt(targetU, wantLateral, p);

    // --- steering ----------------------------------------------------------
    const toX = p.x - kart.x;
    const toZ = p.z - kart.z;
    // ---- pure pursuit ----------------------------------------------------
    // The steering angle that puts the kart on a circular arc through the aim
    // point: curvature = 2·sin(alpha) / L, steering angle = atan(curvature ·
    // wheelbase). It is self-limiting — the demand falls as the target comes
    // into line — which a proportional gain is not.
    //
    // Symptom this replaces: `angleError * 2.2` saturated at any error past 26°.
    // From the grid, with a 6 m look-ahead and the kart two metres off the line,
    // the very first frame already demanded full lock; the kart oscillated,
    // ran wide, and spent the entire race pinned to the outside barrier with
    // steer reading exactly -1.00. Not one AI race in four ever finished.
    const desiredHeading = Math.atan2(toX, toZ);
    const alpha = wrapAngle(desiredHeading - kart.heading);
    const aimDistance = Math.max(4, Math.hypot(toX, toZ));
    const pathCurvature = (2 * Math.sin(alpha)) / aimDistance;
    const wantAngle = Math.atan(pathCurvature * CONFIG.kart.wheelbase);

    // Expressed as a fraction of the lock actually available at this speed, so
    // the control struct means the same thing it does from a thumb.
    const speedT = clamp01(speed / CONFIG.kart.steer.fullEffectSpeed);
    const maxLock =
      CONFIG.kart.steer.maxAngleLow +
      (CONFIG.kart.steer.maxAngleHigh - CONFIG.kart.steer.maxAngleLow) * speedT;
    out.steer = clamp(wantAngle / Math.max(0.05, maxLock) + this.mistakeSteer, -1, 1);

    // --- speed profile -----------------------------------------------------
    // The profile is followed at a fraction set by skill. This is the only
    // place difficulty touches pace, and it is the AI's *own* pace — it does
    // not depend on where the player is. That is the whole rule.
    const profileIdx = Math.floor(wrapLength(u + speed * 0.35, this.line.length) / this.line.spacing) %
      this.line.speed.length;
    const skillScale = A.skillSpeedFloor + (A.skillSpeedCeiling - A.skillSpeedFloor) * this.skill;
    const targetSpeed = this.line.speed[profileIdx]! * skillScale * (this.mistakeTimer > 0 ? 0.82 : 1);

    if (speed < targetSpeed - 0.4) {
      out.throttle = 1;
      out.brake = 0;
    } else if (speed > targetSpeed + 1.2) {
      out.throttle = 0;
      // Brake proportionally to the overspeed rather than slamming it on: full
      // brake mid-corner blows the grip circle and the AI understeers off.
      out.brake = clamp01((speed - targetSpeed) / 6);
    } else {
      out.throttle = 0.55;
      out.brake = 0;
    }

    // ================= OFF THE ROAD =================
    // Grip, not pace. Grass gives 58% of the road's lateral grip and sand 44%,
    // so a speed that was correct on the racing line is far past what will turn
    // out here — and the outside of a corner is exactly where a kart that ran
    // wide ends up.
    //
    // Symptom this fixes: the previous version held 70% throttle and set brake
    // to zero. Measured, a solo AI kart with nothing to collide with ran wide
    // within three seconds, pinned itself against the barrier and ground along
    // it at 4 m/s for the rest of the race, steer saturated at -1.00 the whole
    // way. Not one AI race in four ever finished. Under full lock it could not
    // even claw back a metre of lateral offset in six seconds, because the
    // throttle was keeping the tyres saturated in the longitudinal direction
    // and there was nothing left in the grip circle to turn with.
    if (!kart.sample.onRoad) {
      // 9 m/s: measured as the speed at which grass grip (0.58 of the road's)
      // still generates enough lateral force to pull the kart back across the
      // verge inside a couple of seconds. Above it, braking is the only thing
      // worth doing; below it, braking is the wrong thing entirely — the first
      // attempt at this fix braked proportionally to how far out the kart was,
      // which stopped it dead on the grass at 0.2 m/s and left it there for the
      // whole race.
      const RECOVER_SPEED = 9;
      if (speed > RECOVER_SPEED) {
        out.throttle = 0;
        out.brake = clamp01(0.2 + (speed - RECOVER_SPEED) / 6);
      } else {
        // Slow enough to steer now. Power back on, gently — full throttle here
        // saturates the tyres longitudinally again and there is nothing left in
        // the grip circle to turn with.
        out.throttle = 0.55;
        out.brake = 0;
      }
      out.drift = false;
    }

    // --- drift -------------------------------------------------------------
    // Engage when the corner ahead is tight enough to be worth the ~20% speed
    // cost, and only at a skill the driver has. A low-skill AI drifting badly
    // is slower than a low-skill AI not drifting, which is realistic and also
    // how a beginner-difficulty field should behave.
    const cornerSpeed = this.line.speed[profileIdx]!;
    const wantsDrift =
      this.skill > 0.55 &&
      speed > CONFIG.kart.drift.minSpeed + 2 &&
      cornerSpeed < CONFIG.kart.topSpeed * 0.78 &&
      Math.abs(out.steer) > 0.32 &&
      this.mistakeTimer <= 0;
    out.drift = wantsDrift;

    out.useItem = this.shouldUseItem(kart);
    out.lookBack = false;
  }

  private updateMistakes(dt: number): void {
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      if (this.mistakeTimer <= 0) this.mistakeSteer = 0;
      return;
    }
    this.nextMistakeCheck -= dt;
    if (this.nextMistakeCheck > 0) return;
    this.nextMistakeCheck = 1.0;

    // Sloppiness is mistakes per minute at skill 0, scaled down by skill and by
    // difficulty. At skill 0.9 and difficulty 1 this is close to zero.
    const perMinute = this.spec.ai.sloppiness * (1 - this.skill * 0.85);
    if (this.rng.bool(perMinute / 60)) {
      this.mistakeTimer = A.mistakeDuration;
      this.mistakeSteer = this.rng.range(-0.28, 0.28);
    }
  }

  /**
   * Lateral deviation to avoid — or lean on — a kart ahead.
   *
   * Aggression decides which: a timid driver lifts and moves over, an
   * aggressive one keeps the throttle down and takes the gap, which is what
   * makes the field feel like drivers rather than like traffic.
   */
  private updateAvoidance(dt: number, rivals: Kart[]): void {
    const kart = this.kart;
    let nearest: Kart | null = null;
    let nearestGap = Infinity;

    for (const other of rivals) {
      if (other === kart) continue;
      const gap = loopDelta(kart.sample.u, other.sample.u, this.line.length);
      if (gap <= 0 || gap > A.avoidLookAhead) continue;
      const lateralGap = Math.abs(other.sample.lateral - kart.sample.lateral);
      if (lateralGap > CONFIG.kart.collision.radius * 4) continue;
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = other;
      }
    }

    if (nearest) {
      const side = nearest.sample.lateral >= kart.sample.lateral ? -1 : 1;
      const urgency = clamp01(1 - nearestGap / A.avoidLookAhead);
      const aggression = this.spec.ai.aggression;
      // An aggressive driver commits to a smaller gap; a timid one gives the
      // rival the whole corner.
      this.deviationTarget = side * A.lineDeviation * urgency * (0.5 + 0.5 * aggression);
    } else {
      this.deviationTarget = 0;
    }
    // Approached at 2.2/s: a rival appearing alongside must not produce an
    // instant swerve, which reads as the AI teleporting sideways.
    this.deviation += (this.deviationTarget - this.deviation) * clamp01(2.2 * dt);
  }
}
