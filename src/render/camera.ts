import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { approach, clamp01, wrapAngle } from '../core/mathx.ts';
import type { Kart } from '../vehicle/kart.ts';

/**
 * The chase camera, and most of what makes the game *feel* fast.
 *
 * None of this changes the simulation. All of it changes how fast the game
 * feels, which is the point: FOV widens with speed and punches on boost, the
 * camera pulls back under acceleration, and a small shake lands on boosts and
 * impacts.
 *
 * ============ BUG CLASS 12: MOTION SICKNESS ============
 * Banked tracks plus a rolling camera plus an FOV kick is how you make people
 * ill. The camera therefore takes only a **fraction** of the track's roll
 * (0.34), and the "reduce camera motion" option scales roll, shake and FOV kick
 * together down to 0.15 of their normal values. The option is real and
 * reachable from the pause menu, not a checkbox that does nothing.
 */

const C = CONFIG.camera;

export type CameraPreset = 'chase' | 'close' | 'far' | 'bumper' | 'orbit' | 'overhead' | 'trackside';

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  reduceMotion = false;

  private readonly position = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private roll = 0;
  private fov: number = C.fovBase;
  private shake = 0;
  private shakeSeed = 0;
  private preset: CameraPreset = 'chase';
  private orbitAngle = 0;
  private initialised = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(C.fovBase, aspect, 0.25, 1200);
  }

  setPreset(preset: CameraPreset): void {
    this.preset = preset;
    this.initialised = false;
  }

  get currentPreset(): CameraPreset {
    return this.preset;
  }

  /** Add a shake impulse. Impacts and boosts call this; nothing else should. */
  addShake(amount: number): void {
    const scale = this.reduceMotion ? C.reducedMotionScale : 1;
    this.shake = Math.min(1.2, this.shake + amount * scale);
  }

  get fieldOfView(): number {
    return this.fov;
  }

  update(dt: number, kart: Kart, alpha: number, lookBack: boolean): void {
    const motionScale = this.reduceMotion ? C.reducedMotionScale : 1;

    // Interpolated kart state, for the same reason the kart view uses it.
    const kx = kart.prevX + (kart.x - kart.prevX) * alpha;
    const ky = kart.prevY + (kart.y - kart.prevY) * alpha;
    const kz = kart.prevZ + (kart.z - kart.prevZ) * alpha;

    // Follow the *heading*, not the velocity: chasing the velocity vector in a
    // drift swings the camera round to look at the kart's side, which is
    // exactly when the player most needs to see where they are going.
    const heading = kart.heading + (lookBack ? Math.PI : 0);
    const speedFactor = clamp01(kart.speed / CONFIG.kart.topSpeed);

    let distance: number = C.distance;
    let height: number = C.height;
    let lookAhead: number = C.lookAhead;
    switch (this.preset) {
      case 'close':
        distance = 4.2;
        height = 1.9;
        break;
      case 'far':
        distance = 9.5;
        height = 4.2;
        break;
      case 'bumper':
        distance = -0.2;
        height = 1.05;
        lookAhead = 12;
        break;
      case 'orbit':
      case 'overhead':
      case 'trackside':
        break;
      case 'chase':
        break;
    }

    if (this.preset === 'orbit') {
      this.orbitAngle += dt * 0.35;
      this.desired.set(
        kx + Math.sin(this.orbitAngle) * 7.5,
        ky + 3.4,
        kz + Math.cos(this.orbitAngle) * 7.5,
      );
      this.lookTarget.set(kx, ky + 0.5, kz);
      this.applyImmediate();
      return;
    }
    if (this.preset === 'overhead') {
      this.desired.set(kx, ky + 42, kz + 0.01);
      this.lookTarget.set(kx, ky, kz);
      this.applyImmediate();
      return;
    }
    if (this.preset === 'trackside') {
      const rx = Math.cos(kart.heading);
      const rz = -Math.sin(kart.heading);
      this.desired.set(kx + rx * 14, ky + 4.5, kz + rz * 14);
      this.lookTarget.set(kx, ky + 0.6, kz);
      this.applyImmediate();
      return;
    }

    // Pull back under acceleration. Subtle — 0.9 m at full chat — but it is
    // most of why acceleration reads as acceleration.
    const pullBack = distance + speedFactor * 0.9;

    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    this.desired.set(kx - fx * pullBack, ky + height, kz - fz * pullBack);

    // Keep the camera above the track surface. Without this it drops through
    // the road on a crest and the player spends a second looking at the
    // underside of the world.
    const groundY = kart.sample.height;
    if (this.desired.y < groundY + 1.1) this.desired.y = groundY + 1.1;

    if (!this.initialised) {
      this.position.copy(this.desired);
      this.lookTarget.set(kx + fx * lookAhead, ky + 0.7, kz + fz * lookAhead);
      this.initialised = true;
    }

    // Exponential approach, frame-rate independent. A fixed per-frame lerp
    // constant means something different at 30 fps and at 144 fps.
    this.position.x = approach(this.position.x, this.desired.x, C.followRate, dt);
    this.position.y = approach(this.position.y, this.desired.y, C.followRate, dt);
    this.position.z = approach(this.position.z, this.desired.z, C.followRate, dt);

    const targetX = kx + fx * lookAhead;
    const targetY = ky + 0.7 + kart.sample.ty * lookAhead * 0.6;
    const targetZ = kz + fz * lookAhead;
    this.lookTarget.x = approach(this.lookTarget.x, targetX, C.lookRate, dt);
    this.lookTarget.y = approach(this.lookTarget.y, targetY, C.lookRate, dt);
    this.lookTarget.z = approach(this.lookTarget.z, targetZ, C.lookRate, dt);

    // --- roll ---------------------------------------------------------------
    // A fraction of the track's bank, damped. Full bank roll plus FOV kick is
    // the recipe for making people ill.
    const bank = Math.atan2(kart.sample.nx * Math.cos(kart.heading) - kart.sample.nz * Math.sin(kart.heading), kart.sample.ny);
    const targetRoll = bank * C.rollFraction * motionScale;
    this.roll = approach(this.roll, targetRoll, C.rollRate, dt);

    // --- FOV ----------------------------------------------------------------
    const boosting = kart.boostTime > 0 ? 1 : 0;
    const targetFov =
      C.fovBase +
      speedFactor * C.fovSpeedGain * motionScale +
      boosting * C.fovBoostKick * motionScale;
    this.fov = approach(this.fov, targetFov, C.fovRate, dt);

    // --- shake --------------------------------------------------------------
    this.shake = Math.max(0, this.shake - C.shakeDecay * dt * this.shake - 0.001);
    this.shakeSeed += dt * 43;

    this.camera.position.copy(this.position);
    if (this.shake > 0.001) {
      const s = this.shake * 0.24;
      this.camera.position.x += Math.sin(this.shakeSeed * 1.7) * s;
      this.camera.position.y += Math.sin(this.shakeSeed * 2.3 + 1.1) * s;
      this.camera.position.z += Math.sin(this.shakeSeed * 1.9 + 2.7) * s;
    }

    this.up.set(Math.sin(this.roll), Math.cos(this.roll), 0).applyAxisAngle(
      AXIS_Y,
      heading,
    );
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.lookTarget);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private applyImmediate(): void {
    this.camera.position.copy(this.desired);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.lookTarget);
    if (Math.abs(this.camera.fov - C.fovBase) > 0.01) {
      this.camera.fov = C.fovBase;
      this.camera.updateProjectionMatrix();
    }
    this.fov = C.fovBase;
  }

  setAspect(aspect: number): void {
    if (Math.abs(this.camera.aspect - aspect) < 1e-4) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Camera-relative heading of a point, for the off-screen item warning. */
  bearingTo(x: number, z: number): number {
    return wrapAngle(
      Math.atan2(x - this.camera.position.x, z - this.camera.position.z) -
        Math.atan2(
          this.lookTarget.x - this.camera.position.x,
          this.lookTarget.z - this.camera.position.z,
        ),
    );
  }
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);
