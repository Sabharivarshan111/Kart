import { CONFIG } from '../core/config.ts';
import { SurfaceKind } from '../core/contracts.ts';
import type { Controls, DriverSpec, SurfaceSample } from '../core/contracts.ts';
import { sanitiseControls } from '../core/controls.ts';
import { approach, clamp, clamp01, wrapAngle } from '../core/mathx.ts';
import { blankSample, type TrackSurface } from '../track/surface.ts';

/**
 * ===================== THE FEEL =====================
 *
 * Four wheels, each a downward cast from the chassis with a spring and a
 * damper. Per wheel: a suspension force along the contact normal, a drive force
 * along its own forward direction, and a lateral friction force — with the
 * combined longitudinal and lateral force clamped to a **grip circle**.
 *
 * That clamp is the entire difference between a car and a brick on rails. It is
 * what makes braking mid-corner lose grip, what makes a drift cost you speed,
 * and what makes weight transfer matter. Everything else here is detail.
 *
 * Weight transfer is not modelled separately: it falls out of the suspension
 * for free. Brake and the front springs compress, which raises the front tyres'
 * load and lowers the rear's, which changes their grip. The visible nose-dive
 * is the same fact, drawn.
 *
 * Integration is fixed-step at 120 Hz (ARCHITECTURE.md §4) and this class never
 * allocates: every vector is a triple of numbers on `this` or a module-scope
 * scratch. A `new Vector3()` in here is a defect.
 */

const K = CONFIG.kart;
const GRAVITY = 9.81;

/** Per-surface handling, indexed by SurfaceKind. */
const SURFACE_TABLE = [
  CONFIG.surfaces.road,
  CONFIG.surfaces.kerb,
  CONFIG.surfaces.grass,
  CONFIG.surfaces.sand,
  CONFIG.surfaces.boost,
  CONFIG.surfaces.void,
] as const;

export interface WheelState {
  /** Local offset from the chassis origin. */
  offsetX: number;
  offsetZ: number;
  front: boolean;
  /** Suspension compression, metres. 0 = fully extended (no contact). */
  compression: number;
  compressionRate: number;
  grounded: boolean;
  /** Load in newtons, for the grip circle. */
  load: number;
  /** Spin angle for the visual. */
  spin: number;
  /** World contact point, for sparks and skid marks. */
  contactX: number;
  contactY: number;
  contactZ: number;
  surface: SurfaceKind;
  /** Lateral slip at this wheel, m/s. */
  slip: number;
}

export type BoostSource = 'none' | 'drift' | 'strip' | 'item' | 'trick' | 'landing' | 'start';

export class Kart {
  readonly index: number;
  readonly isPlayer: boolean;
  readonly driver: DriverSpec;

  // --- state ---------------------------------------------------------------
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Yaw. 0 faces +Z; increasing turns right. */
  heading = 0;
  yawRate = 0;
  pitch = 0;
  roll = 0;
  /** Angular rates used only while airborne. */
  pitchRate = 0;
  rollRate = 0;

  /** Interpolation source for rendering — the previous physics state. */
  prevX = 0;
  prevY = 0;
  prevZ = 0;
  prevHeading = 0;
  prevPitch = 0;
  prevRoll = 0;
  prevVisualYaw = 0;

  readonly wheels: WheelState[] = [];

  steerAngle = 0;
  /** Extra yaw applied by the drift, kept separate so the *visual* body angle
   *  can diverge from the direction of travel without the physics losing track
   *  of which way the kart is actually pointed. */
  driftYaw = 0;

  drifting = false;
  /** -1 left, +1 right, 0 not drifting. */
  driftDirection = 0;
  driftCharge = 0;
  driftTier = 0;
  hopTimer = 0;
  /** Set for one step when a drift starts, so audio and FX can fire once. */
  hopFired = false;

  boostTime = 0;
  boostSpeedBonus = 0;
  boostSource: BoostSource = 'none';
  /** Set for one step when a boost begins. */
  boostFired: BoostSource | null = null;

  airborne = false;
  airtime = 0;
  coyote = 0;
  trickArmed = false;
  trickUsed = false;
  landedHard = false;
  /** Set for one step on landing, carrying the flatness dot for the FX. */
  landingFlatness = 0;

  spinOutTimer = 0;
  invulnerable = 0;
  /** Grip stolen by a slick, 0..1. Applied multiplicatively. */
  externalGripScale = 1;
  /** Speed cap imposed by a field effect, as a fraction. */
  externalSpeedScale = 1;

  offTrackTimer = 0;
  respawns = 0;

  /** Latest surface sample under the chassis centre. */
  readonly sample: SurfaceSample = blankSample();
  /** Cached u for the surface query hint. */
  hintU = 0;

  /** Stat-derived multipliers, resolved once from the driver spec. */
  private readonly topSpeedMul: number;
  private readonly accelMul: number;
  private readonly handlingMul: number;
  readonly mass: number;

  constructor(index: number, isPlayer: boolean, driver: DriverSpec) {
    this.index = index;
    this.isPlayer = isPlayer;
    this.driver = driver;

    // Stats map to ±12% around the base kart. Wider than that and the roster
    // stops being a preference and starts being a correct answer.
    this.topSpeedMul = 0.94 + driver.topSpeed * 0.12;
    this.accelMul = 0.90 + driver.acceleration * 0.20;
    this.handlingMul = 0.92 + driver.handling * 0.16;
    // Weight decides who wins a collision, so it has to be a real number rather
    // than a label: a lightweight genuinely loses contact battles.
    this.mass = K.mass * (0.86 + driver.weight * 0.30);

    for (const w of [
      { x: -K.trackWidth / 2, z: K.wheelbase / 2, front: true },
      { x: K.trackWidth / 2, z: K.wheelbase / 2, front: true },
      { x: -K.trackWidth / 2, z: -K.wheelbase / 2, front: false },
      { x: K.trackWidth / 2, z: -K.wheelbase / 2, front: false },
    ]) {
      this.wheels.push({
        offsetX: w.x,
        offsetZ: w.z,
        front: w.front,
        compression: 0,
        compressionRate: 0,
        grounded: false,
        load: 0,
        spin: 0,
        contactX: 0,
        contactY: 0,
        contactZ: 0,
        surface: SurfaceKind.Road,
        slip: 0,
      });
    }
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  /** Signed lateral velocity in the kart's own frame. Positive means sliding to
   *  the kart's right. This — not the button — is what charges a drift. */
  get lateralSlip(): number {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    return this.vx * rx + this.vz * rz;
  }

  get forwardSpeed(): number {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    return this.vx * fx + this.vz * fz;
  }

  get wheelsOnGround(): number {
    let n = 0;
    for (const w of this.wheels) if (w.grounded) n++;
    return n;
  }

  /** The kart's up vector, from yaw/pitch/roll in YXZ order. */
  upX = 0;
  upY = 1;
  upZ = 0;

  private updateBasis(): void {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);
    const cy = Math.cos(this.heading);
    const sy = Math.sin(this.heading);
    // Rz(roll) then Rx(pitch) then Ry(yaw), applied to (0,1,0).
    const ax = -sr;
    const ay = cr * cp;
    const az = cr * sp;
    this.upX = ax * cy + az * sy;
    this.upY = ay;
    this.upZ = -ax * sy + az * cy;
  }

  placeAt(x: number, y: number, z: number, heading: number, speed = 0): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.heading = heading;
    this.vx = Math.sin(heading) * speed;
    this.vy = 0;
    this.vz = Math.cos(heading) * speed;
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.driftYaw = 0;
    this.cancelDrift();
    this.spinOutTimer = 0;
    this.airborne = false;
    this.airtime = 0;
    this.offTrackTimer = 0;
    this.syncPrevious();
    this.updateBasis();
  }

  syncPrevious(): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.prevHeading = this.heading;
    this.prevPitch = this.pitch;
    this.prevRoll = this.roll;
    this.prevVisualYaw = this.heading + this.driftYaw;
  }

  /** Grant a boost. Later boosts do not stack in duration — they take the best
   *  of the two — but an item boost on top of a drift boost does raise the
   *  ceiling, which is what makes chaining them worth doing. */
  grantBoost(seconds: number, speedBonus: number, source: BoostSource): void {
    if (seconds > this.boostTime) {
      this.boostTime = seconds;
      this.boostSource = source;
      this.boostFired = source;
    }
    this.boostSpeedBonus = Math.max(this.boostSpeedBonus, speedBonus);
  }

  spinOut(): boolean {
    if (this.invulnerable > 0 || this.spinOutTimer > 0) return false;
    this.spinOutTimer = K.spinOut.duration;
    const keep = K.spinOut.speedKeep;
    this.vx *= keep;
    this.vz *= keep;
    this.boostTime = 0;
    this.boostSpeedBonus = 0;
    this.cancelDrift();
    return true;
  }

  cancelDrift(): void {
    this.drifting = false;
    this.driftDirection = 0;
    this.driftCharge = 0;
    this.driftTier = 0;
  }

  /** Top speed including stats, boost and any external slow. */
  currentTopSpeed(): number {
    const base = K.topSpeed * this.topSpeedMul;
    const withBoost = this.boostTime > 0 ? base + this.boostSpeedBonus : base;
    return Math.min(K.boostTopSpeed, withBoost) * this.externalSpeedScale;
  }

  // =========================================================================
  //  The step
  // =========================================================================
  step(dt: number, controlsIn: Controls, surface: TrackSurface): void {
    this.syncPrevious();
    this.hopFired = false;
    this.boostFired = null;
    this.landedHard = false;
    this.landingFlatness = 0;

    const controls = controlsIn;
    sanitiseControls(controls);

    // A spun-out kart ignores input entirely. Capped at 1.35 s in CONFIG,
    // because past about a second and a half the player has stopped playing and
    // started watching.
    const spun = this.spinOutTimer > 0;
    if (spun) {
      this.spinOutTimer -= dt;
      if (this.spinOutTimer <= 0) {
        this.spinOutTimer = 0;
        this.invulnerable = Math.max(this.invulnerable, K.spinOut.invulnerability);
      }
    }
    if (this.invulnerable > 0) this.invulnerable -= dt;

    const throttle = spun ? 0 : controls.throttle;
    const brake = spun ? 0 : controls.brake;
    const steerInput = spun ? 0 : controls.steer;

    // --- surface under the chassis centre ---------------------------------
    surface.sample(this.x, this.z, this.sample, this.hintU);
    this.hintU = this.sample.u;

    this.updateBasis();
    this.updateDrift(dt, controls, steerInput, spun);
    this.updateSteering(dt, steerInput);

    // --- per-wheel forces --------------------------------------------------
    let fx = 0;
    let fy = 0;
    let fz = 0;
    let torqueY = 0;
    let grounded = 0;
    let dominantSurface: SurfaceKind = SurfaceKind.Void;
    let bestLoad = -1;

    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const rgtX = Math.cos(this.heading);
    const rgtZ = -Math.sin(this.heading);

    const driveWheels = 2; // rear-wheel drive, like the thing it is modelled on
    const boosting = this.boostTime > 0;
    const topSpeed = this.currentTopSpeed();
    const fwdSpeed = this.forwardSpeed;

    for (const w of this.wheels) {
      // Wheel mount in world space. Uses the flat yaw basis rather than the
      // full pitched/rolled basis: the error is under a centimetre at the
      // angles a kart reaches on the ground, and it keeps this loop branchless.
      const ox = rgtX * w.offsetX + fwdX * w.offsetZ;
      const oz = rgtZ * w.offsetX + fwdZ * w.offsetZ;
      const wx = this.x + ox;
      const wz = this.z + oz;

      surface.sample(wx, wz, WHEEL_SAMPLE, this.hintU);
      const groundY = WHEEL_SAMPLE.height;

      // The cast is vertical rather than along the kart's own up. On a 17°
      // bank that is a 4% error in the compression, which the spring absorbs;
      // casting along -up costs a division per wheel per step and changes
      // nothing visible.
      const restY = this.y + K.suspension.restLength;
      const distance = restY - groundY;
      const target = K.suspension.restLength + K.wheelRadius;
      let compression = target - distance;

      if (compression > 0) {
        compression = Math.min(compression, K.suspension.travel);
        const rate = (compression - w.compression) / dt;
        w.compressionRate = rate;
        w.compression = compression;
        w.grounded = true;
        w.contactX = wx;
        w.contactY = groundY;
        w.contactZ = wz;
        w.surface = WHEEL_SAMPLE.surface;
        grounded++;

        const spring = K.suspension.stiffness * compression;
        const damper = K.suspension.damping * rate;
        // Never pull down: a suspension that can pull is a magnet, and it holds
        // the kart onto the road over crests where it should be flying.
        const load = Math.max(0, spring + damper);
        w.load = load;
        if (load > bestLoad) {
          bestLoad = load;
          dominantSurface = WHEEL_SAMPLE.surface;
        }

        // Suspension pushes along the contact normal.
        fx += WHEEL_SAMPLE.nx * load;
        fy += WHEEL_SAMPLE.ny * load;
        fz += WHEEL_SAMPLE.nz * load;

        // --- tyre forces -------------------------------------------------
        const steerFor = w.front ? this.steerAngle : 0;
        const wa = this.heading + steerFor;
        const tfx = Math.sin(wa);
        const tfz = Math.cos(wa);
        const trx = Math.cos(wa);
        const trz = -Math.sin(wa);

        // Velocity at the wheel: v + ω × r, with ω = (0, yawRate, 0).
        const vwx = this.vx + this.yawRate * oz;
        const vwz = this.vz - this.yawRate * ox;
        const vLong = vwx * tfx + vwz * tfz;
        const vLat = vwx * trx + vwz * trz;
        w.slip = vLat;

        const surf = SURFACE_TABLE[w.surface] ?? CONFIG.surfaces.road;
        const gripScale =
          surf.gripScale *
          this.handlingMul *
          this.externalGripScale *
          (this.drifting ? K.drift.gripMultiplier : 1);

        // Lateral: rises linearly to the saturation slip, then falls away to
        // the sliding fraction. The falling part is what makes a slide
        // continue once it starts instead of snapping back.
        const s = Math.abs(vLat) / K.grip.slipSaturation;
        const curve = s <= 1 ? s : 1 - (1 - K.grip.slidingFraction) * clamp01(s - 1);
        let fLat = -Math.sign(vLat) * curve * K.grip.lateralPeak * load * gripScale;

        // Longitudinal: drive on the rear axle, braking on all four.
        let fLong = 0;
        if (!spun) {
          if (throttle > 0 && !w.front) {
            // Drive force falls to zero at top speed, so acceleration stays
            // honest at the top end rather than becoming asymptotic drag.
            const headroom = clamp01(1 - Math.max(0, fwdSpeed) / Math.max(1, topSpeed));
            const boostForce = boosting ? K.boost.force : 0;
            fLong += ((K.driveForce * this.accelMul + boostForce) / driveWheels) * throttle * headroom;
          }
          if (brake > 0) {
            if (fwdSpeed > 0.4) {
              fLong -= (K.brakeForce / 4) * brake;
            } else {
              // Reverse: deliberately feeble. It exists to unstick you, not to
              // race, and a strong reverse makes every wall a free three-point
              // turn.
              const rHeadroom = clamp01(1 + fwdSpeed / K.reverseTopSpeed);
              fLong -= (K.reverseForce / 4) * brake * rHeadroom;
            }
          }
        }
        // Rolling resistance and surface drag, always opposing motion.
        fLong -= Math.sign(vLong) * Math.min(Math.abs(vLong) * 40, K.rollingResistance * surf.rollScale);

        // ============ THE GRIP CIRCLE ============
        // A tyre has one friction budget and the longitudinal and lateral
        // demands share it. Clamping the *combination* rather than each axis
        // separately is what makes braking mid-corner wash out the front and
        // what makes a drift cost speed.
        const budget = K.grip.lateralPeak * load * gripScale;
        const demand = Math.hypot(fLong, fLat);
        if (demand > budget && demand > 1e-3) {
          const k = budget / demand;
          fLong *= k;
          fLat *= k;
        }

        fx += tfx * fLong + trx * fLat;
        fz += tfz * fLong + trz * fLat;
        torqueY += ox * (tfz * fLong + trz * fLat) - oz * (tfx * fLong + trx * fLat);

        // Wheel spin for the visual.
        w.spin += (vLong / K.wheelRadius) * dt;
      } else {
        w.grounded = false;
        w.compression = 0;
        w.compressionRate = 0;
        w.load = 0;
        w.slip = 0;
        w.spin += (fwdSpeed / K.wheelRadius) * dt;
      }
    }

    const wasAirborne = this.airborne;
    this.airborne = grounded === 0;
    if (this.airborne) {
      this.airtime += dt;
      this.coyote = Math.max(0, this.coyote - dt);
    } else {
      if (wasAirborne) this.onLanding(dt);
      this.airtime = 0;
      this.coyote = K.air.coyoteTime;
    }

    // --- gravity, drag ------------------------------------------------------
    fy -= GRAVITY * this.mass;

    const sp = this.speed;
    if (sp > 0.01) {
      const drag = K.dragCoefficient * sp * sp;
      fx -= (this.vx / sp) * drag;
      fz -= (this.vz / sp) * drag;
    }

    // --- boost strip --------------------------------------------------------
    if (dominantSurface === SurfaceKind.Boost && !spun) {
      this.grantBoost(K.boost.stripBoostTime, K.boost.stripSpeed, 'strip');
    }

    // --- integrate ----------------------------------------------------------
    const invMass = 1 / this.mass;
    this.vx += fx * invMass * dt;
    this.vy += fy * invMass * dt;
    this.vz += fz * invMass * dt;

    // Hard speed ceiling. The drive-force curve does most of the limiting; this
    // catches the case where a boost, a slope and a boost strip conspire.
    const horiz = Math.hypot(this.vx, this.vz);
    const ceiling = boosting ? K.boostTopSpeed : topSpeed * 1.06;
    if (horiz > ceiling) {
      const k = ceiling / horiz;
      this.vx *= k;
      this.vz *= k;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;

    // --- yaw ---------------------------------------------------------------
    if (spun) {
      // Spin-out overrides steering entirely, which is the point of it.
      this.yawRate = K.spinOut.spinRate * (this.index % 2 === 0 ? 1 : -1);
    } else {
      const yawAccel = torqueY / K.yawInertia;
      this.yawRate += yawAccel * dt;
      if (this.drifting) {
        // The drift adds yaw beyond what the tyres produce. Without it the kart
        // washes wide instead of rotating, and the slide reads as a mistake
        // rather than as a technique.
        const commitment = clamp01(Math.abs(this.lateralSlip) / K.grip.slipSaturation);
        this.yawRate += this.driftDirection * K.drift.yawAssist * commitment * dt * 8;
      }
      // Yaw damping. Without it the kart oscillates forever after a correction.
      this.yawRate *= Math.exp(-3.4 * dt);
    }
    this.heading = wrapAngle(this.heading + this.yawRate * dt);

    // --- orientation --------------------------------------------------------
    if (this.airborne) {
      this.updateAirControl(dt, controls, steerInput, spun);
    } else {
      // On the ground the body lies along the surface. Approached rather than
      // snapped, or every kerb is a jolt in the camera.
      const targetPitch = -Math.asin(clamp(this.sample.nz * Math.cos(this.heading) + this.sample.nx * Math.sin(this.heading), -1, 1));
      const targetRoll = Math.asin(clamp(this.sample.nx * Math.cos(this.heading) - this.sample.nz * Math.sin(this.heading), -1, 1));
      this.pitch = approach(this.pitch, targetPitch, 12, dt);
      this.roll = approach(this.roll, targetRoll, 12, dt);
      this.pitchRate = 0;
      this.rollRate = 0;

      // Keep the chassis out of the road. The suspension does the work, but a
      // hard floor stops a spike from putting the kart under the surface, from
      // which nothing recovers.
      const floor = this.sample.height + K.wheelRadius * 0.35;
      if (this.y < floor) {
        this.y = floor;
        if (this.vy < 0) this.vy = 0;
      }
    }

    // --- boost countdown ----------------------------------------------------
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      if (this.boostTime <= 0) {
        this.boostTime = 0;
        this.boostSpeedBonus = 0;
        this.boostSource = 'none';
      }
    }

    // Slick grip and field slow expire on their own; whoever set them re-sets
    // them each step while the effect lasts.
    this.externalGripScale = 1;
    this.externalSpeedScale = 1;

    // --- off-track ----------------------------------------------------------
    if (this.sample.surface === SurfaceKind.Void) {
      this.offTrackTimer += dt;
    } else {
      this.offTrackTimer = 0;
    }
  }

  // -------------------------------------------------------------------------
  private updateSteering(dt: number, steerInput: number): void {
    // Steering authority falls with speed. A kart that turns as sharply at
    // 24 m/s as at 5 m/s is uncontrollable — this is not a nicety.
    const t = clamp01(this.speed / K.steer.fullEffectSpeed);
    let maxAngle = K.steer.maxAngleLow + (K.steer.maxAngleHigh - K.steer.maxAngleLow) * t;
    if (this.drifting) maxAngle += K.steer.driftBonus;
    const target = steerInput * maxAngle * this.handlingMul;
    this.steerAngle = approach(this.steerAngle, target, K.steer.responsiveness, dt);
  }

  private updateDrift(dt: number, controls: Controls, steerInput: number, spun: boolean): void {
    if (this.hopTimer > 0) this.hopTimer -= dt;

    const canInitiate =
      !spun &&
      controls.drift &&
      !this.drifting &&
      this.speed >= K.drift.minSpeed &&
      Math.abs(steerInput) >= K.drift.minSteer &&
      (!this.airborne || this.coyote > 0);

    if (canInitiate) {
      this.drifting = true;
      this.driftDirection = Math.sign(steerInput);
      this.driftCharge = 0;
      this.driftTier = 0;
      // The hop. Not decoration: it is the tell that says the state changed,
      // and without it players cannot tell whether the drift took.
      this.vy += K.drift.hopImpulse;
      this.hopTimer = K.drift.hopDuration;
      this.hopFired = true;
      return;
    }

    if (!this.drifting) return;

    // Cancel conditions: releasing the button, dropping below the cancel speed,
    // spinning out, or steering hard the other way.
    const steeringAway = Math.sign(steerInput) === -this.driftDirection && Math.abs(steerInput) > 0.55;
    if (!controls.drift || this.speed < K.drift.cancelSpeed || spun || steeringAway) {
      this.releaseDrift();
      return;
    }

    // ================= BUG CLASS 3 =================
    // Charge accrues from time spent *genuinely sliding*, not from time holding
    // the button. Gated on both real lateral slip and real speed, so a kart
    // sitting on the grid with the drift button held charges nothing at all.
    const slip = Math.abs(this.lateralSlip);
    const sliding = slip >= K.drift.chargeSlipThreshold && this.speed >= K.drift.minSpeed;
    if (sliding && !this.airborne) {
      this.driftCharge += dt;
    }

    let tier = 0;
    for (let i = 0; i < K.drift.tierTimes.length; i++) {
      if (this.driftCharge >= K.drift.tierTimes[i]!) tier = i + 1;
    }
    this.driftTier = tier;
  }

  private releaseDrift(): void {
    const tier = this.driftTier;
    if (tier > 0) {
      this.grantBoost(K.drift.tierBoost[tier - 1]!, K.drift.tierSpeed[tier - 1]!, 'drift');
    }
    this.cancelDrift();
  }

  private updateAirControl(dt: number, controls: Controls, steerInput: number, spun: boolean): void {
    if (spun) return;
    // Rotation authority in the air. Pitch from throttle/brake, roll and yaw
    // from steering — enough to line a landing up, not enough to fly.
    const pitchDemand = (controls.brake - controls.throttle) * K.air.pitchControl;
    this.pitchRate += pitchDemand * dt;
    this.rollRate += steerInput * K.air.rollControl * dt;
    this.yawRate += steerInput * K.air.yawControl * dt * 0.4;

    this.pitchRate *= Math.exp(-1.6 * dt);
    this.rollRate *= Math.exp(-1.6 * dt);
    this.pitch = wrapAngle(this.pitch + this.pitchRate * dt);
    this.roll = wrapAngle(this.roll + this.rollRate * dt);

    // Trick: a flick while airborne, worth a small boost on landing. The
    // minimum airtime stops it being spammable off every kerb.
    if (this.airtime >= K.air.trickMinAirtime && !this.trickUsed) {
      if (Math.abs(steerInput) > 0.75 || controls.drift) {
        this.trickArmed = true;
      }
    }
  }

  private onLanding(dt: number): void {
    void dt;
    // Flatness: how well the kart's up agrees with the surface it is meeting.
    this.updateBasis();
    const dot = this.upX * this.sample.nx + this.upY * this.sample.ny + this.upZ * this.sample.nz;
    this.landingFlatness = dot;

    if (this.airtime > 0.25) {
      if (dot >= K.air.cosFlat) {
        // Reward being flat.
        this.grantBoost(K.air.landingBonusBoost, 3.0, 'landing');
      } else if (dot < K.air.cosSideways) {
        // Punish being sideways. Losing speed rather than control, because
        // losing control on landing is where a player stops trusting the game.
        this.vx *= K.air.landingBadSpeedKeep;
        this.vz *= K.air.landingBadSpeedKeep;
        this.landedHard = true;
      }
    }

    if (this.trickArmed && !this.trickUsed) {
      this.grantBoost(K.air.trickBoost, 4.0, 'trick');
      this.trickUsed = true;
    }
    this.trickArmed = false;
    this.trickUsed = false;
    // Kill the vertical bounce, or a landing pogos for half a second.
    if (this.vy < 0) this.vy *= 0.25;
  }

  /** Visual yaw: heading plus the drift's body angle. The physics never sees
   *  this — it exists so the kart *looks* sideways in a slide. */
  visualYaw(): number {
    const target = this.drifting
      ? this.driftDirection * -0.42 * clamp01(Math.abs(this.lateralSlip) / K.grip.slipSaturation)
      : 0;
    this.driftYaw += (target - this.driftYaw) * 0.15;
    return this.heading + this.driftYaw;
  }
}

/** Module-scope scratch. Reused by every kart every step — allocating one of
 *  these per wheel per step is 3840 allocations a second at 8 karts. */
const WHEEL_SAMPLE: SurfaceSample = blankSample();
