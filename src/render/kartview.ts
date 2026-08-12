import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { SurfaceKind } from '../core/contracts.ts';
import { DRIFT_TIER_COLOURS } from '../core/palette.ts';
import { accentFor } from '../content/roster.ts';
import type { Kart } from '../vehicle/kart.ts';
import { OBJECT_IDS, tagGeometry } from './celmaterial.ts';
import { buildKartGeometry } from './kartmesh.ts';
import { makeShadowGeometry } from './shadow.ts';
import type { World } from './world.ts';

/**
 * The visual side of a kart: body, four wheels, driver, a projected contact
 * shadow, and everything the kart throws off — drift sparks, boost flame,
 * surface dust and landing debris.
 *
 * Rendering reads **interpolated** state, never the live physics state. The
 * simulation advances in whole 120 Hz steps and a frame almost never lands on a
 * step boundary; drawing the raw state makes a 60 fps display show a
 * two-step-one-step stutter that looks exactly like a frame rate problem and
 * is not one.
 *
 * Every particle comes out of the world's preallocated pools. Nothing here
 * allocates: the emitters use module-scope scratch and integer counters, and a
 * full pool silently drops the emission rather than growing (§4).
 */

const K = CONFIG.kart;
const R = CONFIG.render;

/** Emission rate multiplier per drift tier. Tier 0 is not drifting hard enough
 *  to scrub; the escalation has to be legible at a glance. */
const SPARK_TIER_RATE = [0, 0.45, 0.75, 1.0];

/** Linear-light colours, converted once at construction. A `THREE.Color` per
 *  emitted particle would be an allocation in the frame loop. */
const tierColour = DRIFT_TIER_COLOURS.map((hex) =>
  new THREE.Color().setHex(hex, THREE.SRGBColorSpace),
);

const UP = new THREE.Vector3(0, 1, 0);

/** Surfaces that throw dust when scrubbed, and how much. Road throws tyre
 *  smoke only under a real slide; grass and sand throw material. */
function dustAmount(surface: SurfaceKind): number {
  switch (surface) {
    case SurfaceKind.Grass:
      return 1.0;
    case SurfaceKind.Sand:
      return 1.35;
    case SurfaceKind.Kerb:
      return 0.35;
    default:
      return 0.28;
  }
}

export class KartView {
  readonly group = new THREE.Group();
  readonly kart: Kart;
  private readonly wheelMeshes: THREE.Mesh[] = [];
  private readonly bodyGroup = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private readonly shadowMat: THREE.ShaderMaterial;
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly surfaceNormal = new THREE.Vector3();
  private readonly tiltQuat = new THREE.Quaternion();
  private readonly yawQuat = new THREE.Quaternion();
  private readonly world: World;

  /** Fractional particle budget carried between frames, so a 40/s emitter does
   *  not round to zero at 60 fps and emit nothing at all. */
  private sparkDebt = 0;
  private dustDebt = 0;
  private boostDebt = 0;
  /** Deterministic emitter jitter. `Math.random` is banned in src/ (§5) and a
   *  visual counter is cheaper than forking the gameplay RNG. */
  private jitter = 0;
  private wasAirborne = false;

  private readonly dustColour = new THREE.Color();

  constructor(kart: Kart, world: World, showDriver = true) {
    this.kart = kart;
    this.world = world;
    const geo = buildKartGeometry(kart.driver.colourKey, accentFor(kart.driver));

    // Karts are the hero objects: one band more than the world around them, and
    // a rim strong enough to hold them off the road they are sitting on.
    const bodyMat = world.celMaterial({
      vertexColours: true,
      gloss: 0.18,
      rim: 0.30,
      ramp: 'crisp',
    });
    const body = new THREE.Mesh(tagGeometry(geo.body, OBJECT_IDS.kart), bodyMat);
    this.bodyGroup.add(body);
    world.outlines.attach(body);

    if (showDriver) {
      const driverMat = world.celMaterial({ vertexColours: true, rim: 0.22, ramp: 'crisp' });
      const driver = new THREE.Mesh(tagGeometry(geo.driver, OBJECT_IDS.driver), driverMat);
      this.bodyGroup.add(driver);
      world.outlines.attach(driver);
    }

    const wheelMat = world.celMaterial({ vertexColours: true, gloss: 0.1, ramp: 'crisp' });
    const wheelGeo = tagGeometry(geo.wheel, OBJECT_IDS.wheel);
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      world.outlines.attach(w);
      this.wheelMeshes.push(w);
      this.group.add(w);
    }

    this.group.add(this.bodyGroup);

    // Contact shadow: a blob projected along the sun rather than a shadow map.
    // See shadow.ts for why it is multiplied rather than drawn.
    this.shadowMat = world.shadowMaterial();
    this.shadow = new THREE.Mesh(makeShadowGeometry(), this.shadowMat);
    this.shadow.renderOrder = 1;
    world.track(this.shadow);
    world.addBeautyOnly(this.shadow);

    world.add(this.group);
  }

  /**
   * @param alpha interpolation factor between the previous and current physics
   *   states, from the fixed-step loop.
   */
  update(alpha: number, time: number): void {
    const k = this.kart;
    // Steps the shared pools at most once per frame, whichever view gets here
    // first; every later call this frame sees dt = 0.
    this.world.particles.frame(time);
    const dt = this.world.particles.dt;

    const x = k.prevX + (k.x - k.prevX) * alpha;
    const y = k.prevY + (k.y - k.prevY) * alpha;
    const z = k.prevZ + (k.z - k.prevZ) * alpha;
    this.group.position.set(x, y, z);

    // Yaw is interpolated on the *visual* yaw so the body angle in a drift is
    // smooth too. Interpolating through the short way round matters: at the
    // wrap point a naive lerp spins the kart a full turn in one frame.
    const visualYaw = k.visualYaw();
    let dy = visualYaw - k.prevVisualYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const yaw = k.prevVisualYaw + dy * alpha;

    const pitch = k.prevPitch + (k.pitch - k.prevPitch) * alpha;
    const roll = k.prevRoll + (k.roll - k.prevRoll) * alpha;
    this.euler.set(pitch, yaw, roll);
    this.quat.setFromEuler(this.euler);
    this.group.quaternion.copy(this.quat);

    // Body squats and pitches with the suspension. This is the weight transfer
    // made visible — it is not an animation, it is the springs.
    let front = 0;
    let rear = 0;
    for (const w of k.wheels) {
      if (w.front) front += w.compression;
      else rear += w.compression;
    }
    const bodyPitch = (rear - front) * 0.35;
    this.bodyGroup.rotation.x = bodyPitch;
    this.bodyGroup.position.y = ((front + rear) / 4) * -0.4;

    // Wheels: positioned by their own suspension, steered on the front axle.
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const w = k.wheels[i]!;
      const mesh = this.wheelMeshes[i]!;
      const drop = K.suspension.restLength - w.compression;
      mesh.position.set(w.offsetX, drop - K.suspension.restLength + K.wheelRadius, w.offsetZ);
      mesh.rotation.set(0, 0, 0);
      if (w.front) mesh.rotation.y = k.steerAngle;
      // rotateX after setting yaw applies the spin in the wheel's own frame,
      // which is what makes a steered wheel spin about its own axle rather
      // than about the kart's.
      mesh.rotateX(w.spin);
    }

    this.updateShadow(x, y, z, yaw);
    if (dt > 0) this.emit(dt, x, y, z, yaw);
  }

  /**
   * The shadow is projected, not stuck under the kart: it lies on the surface
   * normal, leans away from the sun by the kart's height, and stretches along
   * that lean. A kart on a banked corner therefore has a shadow lying on the
   * bank, which is the whole reason the surface sample is used rather than a
   * horizontal plane.
   */
  private updateShadow(x: number, y: number, z: number, yaw: number): void {
    const k = this.kart;
    const w = this.world;
    const groundY = k.sample.height;
    const height = Math.max(0, y - groundY);

    this.surfaceNormal.set(k.sample.nx, k.sample.ny, k.sample.nz);
    if (this.surfaceNormal.lengthSq() < 0.5) this.surfaceNormal.copy(UP);
    this.tiltQuat.setFromUnitVectors(UP, this.surfaceNormal);
    // Local +Z is turned to face the direction the shadow falls in, so the
    // stretch (applied to local Z) lies along the sun's ground projection.
    this.yawQuat.setFromAxisAngle(UP, Math.atan2(w.shadowDirX, w.shadowDirZ));
    this.shadow.quaternion.copy(this.tiltQuat).multiply(this.yawQuat);

    const lean = height * w.shadowOffsetPerMetre;
    this.shadow.position.set(
      x + w.shadowDirX * lean,
      groundY + 0.035,
      z + w.shadowDirZ * lean,
    );

    // Grows and fades with height, so a jump reads as height rather than as the
    // shadow detaching. 3.2 m is about the apex of the ramp on Copper Flats.
    const fade = Math.max(0, 1 - height / 3.2);
    const grow = 1 + height * 0.14;
    this.shadow.scale.set(0.95 * grow, 1, 0.95 * grow * w.shadowStretch);
    this.shadowMat.uniforms.uStrength!.value = R.shadowDarkness * fade;
    this.shadow.visible = fade > 0.02;
    // Unused, but keeps the yaw referenced: a kart's own heading deliberately
    // does not turn its shadow, because the sun does not care which way it is
    // pointing.
    void yaw;
  }

  /**
   * Everything the kart throws off. Rates are per second and carried as a
   * fractional debt, so a 34/s emitter still emits at 144 fps and at 30.
   */
  private emit(dt: number, x: number, y: number, z: number, yaw: number): void {
    const k = this.kart;
    const p = this.world.particles;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    // --- drift sparks -------------------------------------------------------
    const tier = Math.min(k.driftTier, SPARK_TIER_RATE.length - 1);
    const sparkRate = k.drifting ? R.sparkRate * SPARK_TIER_RATE[tier]! : 0;
    if (sparkRate > 0) {
      const col = tierColour[Math.min(tier, tierColour.length - 1)]!;
      for (const w of k.wheels) {
        if (w.front || !w.grounded) continue;
        this.sparkDebt += sparkRate * dt * 0.5; // rate is per axle, split per wheel
        while (this.sparkDebt >= 1) {
          this.sparkDebt -= 1;
          const j1 = this.rand();
          const j2 = this.rand();
          const j3 = this.rand();
          // Thrown backwards and outwards from the contact patch, with a lick
          // of upward velocity — a spark that only travels backwards reads as a
          // stripe rather than as a shower.
          p.emit(
            'spark',
            w.contactX, w.contactY + 0.06, w.contactZ,
            -sin * (3.5 + j1 * 5.0) + cos * (j2 - 0.5) * 3.2,
            1.4 + j3 * 2.6,
            -cos * (3.5 + j1 * 5.0) - sin * (j2 - 0.5) * 3.2,
            0.24 + j2 * 0.16,
            0.085, 0.02,
            col.r, col.g, col.b,
            0.55, 2.4,
          );
        }
      }
    } else {
      this.sparkDebt = 0;
    }

    // --- boost flame --------------------------------------------------------
    if (k.boostTime > 0) {
      this.boostDebt += R.boostRate * dt;
      const col = tierColour[tierColour.length - 1]!;
      while (this.boostDebt >= 1) {
        this.boostDebt -= 1;
        const j1 = this.rand();
        const j2 = this.rand();
        const j3 = this.rand();
        // Two nozzles, one either side of the rear axle.
        const side = j3 > 0.5 ? 0.34 : -0.34;
        const ox = x - sin * 0.95 + cos * side;
        const oz = z - cos * 0.95 - sin * side;
        // Hot core to tier colour: the flame starts near-white and cools as it
        // falls behind, which is what makes it read as exhaust and not as a
        // coloured ribbon.
        const hot = 0.55 + j1 * 0.45;
        p.emit(
          'spark',
          ox, y + 0.22 + j2 * 0.12, oz,
          -sin * (2.0 + j1 * 3.0) + cos * (j2 - 0.5) * 1.1,
          0.5 + j2 * 1.1,
          -cos * (2.0 + j1 * 3.0) - sin * (j2 - 0.5) * 1.1,
          0.22 + j1 * 0.14,
          0.26, 0.05,
          col.r + hot, col.g + hot * 0.8, col.b + hot * 0.5,
          -0.12, 3.4,
        );
      }
    } else {
      this.boostDebt = 0;
    }

    // --- surface dust -------------------------------------------------------
    // Thrown when a driven wheel is actually scrubbing, and coloured by what it
    // is scrubbing on. This is the cue that tells you at a glance you have put
    // two wheels on the grass.
    const slip = Math.min(1, Math.abs(k.lateralSlip) / K.grip.slipSaturation);
    for (const w of k.wheels) {
      if (!w.grounded) continue;
      const amount = dustAmount(w.surface);
      const loose = w.surface === SurfaceKind.Grass || w.surface === SurfaceKind.Sand;
      // On a loose surface just rolling is enough; on tarmac it needs a slide.
      const drive = loose ? Math.min(1, k.speed / 8) : slip * slip;
      const rate = R.dustRate * amount * drive * 0.25;
      if (rate <= 0.001) continue;
      this.dustDebt += rate * dt;
      while (this.dustDebt >= 1) {
        this.dustDebt -= 1;
        this.dustColourFor(w.surface);
        const j1 = this.rand();
        const j2 = this.rand();
        const j3 = this.rand();
        p.emit(
          'dust',
          w.contactX + (j1 - 0.5) * 0.3, w.contactY + 0.1, w.contactZ + (j2 - 0.5) * 0.3,
          -sin * (1.0 + j1 * 2.2) + (j2 - 0.5) * 1.6,
          0.8 + j3 * 1.2,
          -cos * (1.0 + j1 * 2.2) + (j3 - 0.5) * 1.6,
          0.5 + j2 * 0.45,
          0.16, 0.62,
          this.dustColour.r, this.dustColour.g, this.dustColour.b,
          -0.18, 1.9,
        );
      }
    }

    // --- landing debris -----------------------------------------------------
    // A burst rather than a rate: the moment of contact is the whole point.
    // Only a landing worth seeing. Below a fifth of a second of airtime this
    // fires on every kerb strip and on the teleport the harness uses to place a
    // kart, which is where the perfectly circular puff in the early frames came
    // from.
    if (this.wasAirborne && !k.airborne && k.airtime > 0.2) {
      this.dustColourFor(k.sample.surface);
      for (let i = 0; i < 14; i++) {
        const j0 = this.rand();
        // Jittered off the exact spoke. Fourteen evenly spaced particles read
        // as a drawn ring rather than as debris — the regularity is the tell.
        const a = ((i + j0 * 0.9) / 14) * Math.PI * 2;
        const j1 = this.rand();
        p.emit(
          'dust',
          x + Math.cos(a) * 0.55, k.sample.height + 0.12, z + Math.sin(a) * 0.55,
          Math.cos(a) * (2.4 + j1 * 2.0),
          1.1 + j1 * 1.4,
          Math.sin(a) * (2.4 + j1 * 2.0),
          0.45 + j1 * 0.3,
          0.2, 0.7,
          this.dustColour.r, this.dustColour.g, this.dustColour.b,
          -0.1, 2.6,
        );
      }
    }
    this.wasAirborne = k.airborne;
  }

  /** The dust colour for a surface, written into the scratch colour. */
  private dustColourFor(surface: SurfaceKind): void {
    const t = this.world.theme;
    const hex =
      surface === SurfaceKind.Grass ? t.grass : surface === SurfaceKind.Sand ? t.sand : t.road;
    this.dustColour.setHex(hex, THREE.SRGBColorSpace);
    // Lifted toward the sky: airborne dust is lit from every direction and a
    // puff the same value as the ground it came off is invisible.
    this.dustColour.lerp(WHITE, 0.42);
  }

  /**
   * A deterministic 0..1 jitter. Seeded per view from the kart index so eight
   * karts do not throw identical sparks, and advanced by a fixed irrational
   * step so the sequence never cycles visibly.
   */
  private rand(): number {
    this.jitter = (this.jitter + 0.6180339887 + this.kart.index * 0.0173) % 1;
    // One more mix, or the sequence is a visible sweep rather than a scatter.
    const s = Math.sin(this.jitter * 127.1) * 43758.5453;
    return s - Math.floor(s);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    this.shadow.visible = v;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
