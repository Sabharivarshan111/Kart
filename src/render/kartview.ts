import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { DRIFT_TIER_COLOURS, COMMON } from '../core/palette.ts';
import { accentFor } from '../content/roster.ts';
import type { Kart } from '../vehicle/kart.ts';
import { OBJECT_IDS, tagGeometry } from './celmaterial.ts';
import { MeshBuilder } from './geombuild.ts';
import { buildKartGeometry } from './kartmesh.ts';
import type { World } from './world.ts';

/**
 * The visual side of a kart: body, four wheels, driver, a contact shadow, and
 * the drift sparks.
 *
 * Rendering reads **interpolated** state, never the live physics state. The
 * simulation advances in whole 120 Hz steps and a frame almost never lands on a
 * step boundary; drawing the raw state makes a 60 fps display show a
 * two-step-one-step stutter that looks exactly like a frame rate problem and
 * is not one.
 */

const K = CONFIG.kart;

/** Sparks per drift tier. Kept small: the escalation has to be legible at a
 *  glance, and a hundred particles reads as smoke rather than as tier three. */
const SPARKS_PER_TIER = [0, 6, 10, 16];

export class KartView {
  readonly group = new THREE.Group();
  readonly kart: Kart;
  private readonly wheelMeshes: THREE.Mesh[] = [];
  private readonly bodyGroup = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private readonly sparks: THREE.Points;
  private readonly sparkPositions: Float32Array;
  private readonly sparkMaterial: THREE.PointsMaterial;
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(kart: Kart, world: World, showDriver = true) {
    this.kart = kart;
    const geo = buildKartGeometry(kart.driver.colourKey, accentFor(kart.driver));

    const bodyMat = world.celMaterial({ vertexColours: true, gloss: 0.16, rim: 0.1 });
    const body = new THREE.Mesh(tagGeometry(geo.body, OBJECT_IDS.kart), bodyMat);
    this.bodyGroup.add(body);
    world.outlines.attach(body);

    if (showDriver) {
      const driverMat = world.celMaterial({ vertexColours: true, rim: 0.08 });
      const driver = new THREE.Mesh(tagGeometry(geo.driver, OBJECT_IDS.driver), driverMat);
      this.bodyGroup.add(driver);
      world.outlines.attach(driver);
    }

    const wheelMat = world.celMaterial({ vertexColours: true, gloss: 0.1 });
    const wheelGeo = tagGeometry(geo.wheel, OBJECT_IDS.wheel);
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      world.outlines.attach(w);
      this.wheelMeshes.push(w);
      this.group.add(w);
    }

    this.group.add(this.bodyGroup);

    // Contact shadow: a flat disc under the kart rather than a shadow map.
    // A cel look wants a hard-edged blob, and a 1024² shadow map costs more
    // than the eight karts' geometry put together on a phone.
    const sb = new MeshBuilder();
    sb.cylinder(0, 0, 0, 0.85, 0.02, 12, COMMON.tyre);
    this.shadow = new THREE.Mesh(
      sb.build(),
      world.celMaterial({ vertexColours: true, transparent: true, opacity: 0.28 }),
    );
    this.shadow.renderOrder = 1;
    world.add(this.shadow);

    const maxSparks = SPARKS_PER_TIER[SPARKS_PER_TIER.length - 1]! * 2;
    this.sparkPositions = new Float32Array(maxSparks * 3);
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3));
    this.sparkMaterial = new THREE.PointsMaterial({
      size: 0.22,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
    });
    this.sparks = new THREE.Points(sparkGeo, this.sparkMaterial);
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    world.add(this.sparks);

    world.add(this.group);
  }

  /**
   * @param alpha interpolation factor between the previous and current physics
   *   states, from the fixed-step loop.
   */
  update(alpha: number, time: number): void {
    const k = this.kart;
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

    // Shadow: on the surface under the kart, fading with height so a jump
    // reads as height rather than as the shadow detaching.
    const groundY = k.sample.height;
    this.shadow.position.set(x, groundY + 0.03, z);
    const height = Math.max(0, y - groundY);
    const fade = Math.max(0, 1 - height / 3.2);
    (this.shadow.material as THREE.ShaderMaterial).uniforms.uOpacity!.value = 0.3 * fade;
    this.shadow.scale.setScalar(1 + height * 0.12);
    this.shadow.visible = fade > 0.02;

    this.updateSparks(time);
  }

  private updateSparks(time: number): void {
    const k = this.kart;
    const tier = k.driftTier;
    const count = SPARKS_PER_TIER[Math.min(tier, SPARKS_PER_TIER.length - 1)]!;
    if (!k.drifting || count === 0) {
      this.sparks.visible = false;
      return;
    }
    this.sparks.visible = true;
    this.sparkMaterial.color.setHex(
      DRIFT_TIER_COLOURS[Math.min(tier, DRIFT_TIER_COLOURS.length - 1)]!,
      THREE.SRGBColorSpace,
    );

    // Emitted from the rear wheel contact points, which is where the tyre is
    // actually scrubbing. Attached to the contacts rather than to the kart's
    // centre so they stay put on the road as the kart rotates over them.
    let n = 0;
    for (const w of k.wheels) {
      if (w.front || !w.grounded) continue;
      for (let s = 0; s < count && n < this.sparkPositions.length / 3; s++) {
        const t = (time * 9 + s * 1.7 + w.offsetX) % 1;
        const spread = t * 1.9;
        this.sparkPositions[n * 3 + 0] = w.contactX - Math.sin(k.heading) * spread + Math.sin(s * 12.9) * 0.22 * t;
        this.sparkPositions[n * 3 + 1] = w.contactY + 0.08 + t * 0.45;
        this.sparkPositions[n * 3 + 2] = w.contactZ - Math.cos(k.heading) * spread + Math.cos(s * 7.3) * 0.22 * t;
        n++;
      }
    }
    for (let i = n; i < this.sparkPositions.length / 3; i++) {
      // Park unused sparks under the road rather than at the origin, where they
      // would draw a permanent pile in the middle of the track.
      this.sparkPositions[i * 3 + 1] = -1000;
    }
    this.sparks.geometry.attributes.position!.needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    this.shadow.visible = v;
    if (!v) this.sparks.visible = false;
  }
}
