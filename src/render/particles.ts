import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { LAYER_BEAUTY_ONLY } from './celmaterial.ts';

/**
 * Pooled billboard particles.
 *
 * Everything here is **preallocated**: the pools, the vertex buffers and the
 * scratch state are all built once at load, and emitting a particle writes into
 * a free slot. There is no allocation anywhere in `emit` or `update`, which is
 * the frame-loop rule (ARCHITECTURE.md §4) and also the difference between a
 * boost that looks good and a boost that stutters the first time eight karts
 * fire one at the same corner.
 *
 * Two pools, because two blend modes are needed and each costs one draw call:
 *
 *  - **spark** — additive. Drift sparks, boost flame, impact flash. Additive is
 *    what makes them read as *light* rather than as coloured confetti.
 *  - **dust** — alpha. Tyre smoke, grass and sand kicked up, landing puffs.
 *    Additive dust over a bright road turns white and disappears.
 *
 * The quads are billboarded in **view space** — the corner offset is added
 * after the view transform — so a particle always faces the camera without a
 * per-particle matrix or a CPU-side rotation.
 *
 * Particle meshes live on `LAYER_BEAUTY_ONLY`, which the G-buffer pass excludes.
 * A spark has no surface for a crease to be on; letting it write a normal and a
 * depth draws a hard ink ring around every single one.
 */

export type PoolKind = 'spark' | 'dust';

const PARTICLE_VERTEX = /* glsl */ `
  // 'position' carries the quad corner in x,y — named that way because Three
  // requires a position attribute to size the draw, and reusing it saves an
  // attribute slot and a buffer.
  attribute vec3 aCentre;
  attribute float aSize;
  attribute vec3 aColour;
  attribute float aAlpha;

  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vCorner;

  void main() {
    vColour = aColour;
    vCorner = position.xy;
    vec4 viewPos = viewMatrix * vec4(aCentre, 1.0);
    // Billboard: the offset is applied in view space, so the quad is always
    // parallel to the near plane whatever the camera is doing.
    viewPos.xy += position.xy * aSize;

    // Near fade.
    //
    // Symptom this fixes: a landing burst emitted under the kart put
    // half-metre puffs a metre from the chase camera, and they covered a
    // quarter of the screen with grey discs — the road, the kerbs and the
    // horizon all vanished behind them. Any billboard system will do this
    // eventually, so the fade is on the pool rather than on the emitter.
    // Gone by 1.2 m, full strength by 3.5 m: the chase camera sits 6 m back,
    // so nothing the player is meant to see is ever touched by this.
    float depth = -viewPos.z;
    vAlpha = aAlpha * smoothstep(1.2, 3.5, depth);

    gl_Position = projectionMatrix * viewPos;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec3 vColour;
  varying float vAlpha;
  varying vec2 vCorner;

  void main() {
    float r = length(vCorner);
    // Hard-edged disc with a brighter core: two steps, no falloff. A gaussian
    // blob in a cel frame reads as a bloom artefact rather than as a drawn
    // spark, which is the whole reason these are not Points with a soft sprite.
    if (r > 1.0) discard;
    float core = step(r, 0.46);
    gl_FragColor = vec4(vColour * (0.78 + 0.46 * core), vAlpha);
  }
`;

/** One blend mode's worth of pooled quads. */
class Pool {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;

  private readonly centre: Float32Array;
  private readonly size: Float32Array;
  private readonly colour: Float32Array;
  private readonly alpha: Float32Array;

  // Per-particle simulation state, parallel arrays so nothing is allocated.
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;

  private active = 0;
  readonly capacity: number;

  constructor(capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.centre = new Float32Array(capacity * 4 * 3);
    this.size = new Float32Array(capacity * 4);
    this.colour = new Float32Array(capacity * 4 * 3);
    this.alpha = new Float32Array(capacity * 4);

    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.cr = new Float32Array(capacity);
    this.cg = new Float32Array(capacity);
    this.cb = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    const corners = new Float32Array(capacity * 4 * 3);
    const index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      corners[(v + 0) * 3 + 0] = -1; corners[(v + 0) * 3 + 1] = -1;
      corners[(v + 1) * 3 + 0] = 1;  corners[(v + 1) * 3 + 1] = -1;
      corners[(v + 2) * 3 + 0] = 1;  corners[(v + 2) * 3 + 1] = 1;
      corners[(v + 3) * 3 + 0] = -1; corners[(v + 3) * 3 + 1] = 1;
      const o = i * 6;
      index[o + 0] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v; index[o + 4] = v + 2; index[o + 5] = v + 3;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(corners, 3));
    this.geometry.setAttribute('aCentre', new THREE.BufferAttribute(this.centre, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geometry.setAttribute('aColour', new THREE.BufferAttribute(this.colour, 3));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // The centres are world-space and the pool spans the whole track, so a
    // bounding sphere would be meaningless and culling it would be wrong.
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_BEAUTY_ONLY);
    this.mesh.renderOrder = 8;
  }

  get count(): number {
    return this.active;
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number,
    size0: number, size1: number,
    r: number, g: number, b: number,
    gravity: number,
    drag: number,
  ): void {
    // Oldest-wins is wrong for this: dropping the *new* particle when full
    // keeps a steady stream steady instead of making it flicker.
    if (this.active >= this.capacity) return;
    const i = this.active++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = size0; this.size1[i] = size1;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
    this.grav[i] = gravity; this.drag[i] = drag;
  }

  update(dt: number): void {
    const g = CONFIG.render.particleGravity;
    let i = 0;
    while (i < this.active) {
      const nl = this.life[i]! - dt;
      if (nl <= 0) {
        // Swap-remove: the last live particle takes this slot, so the active
        // range stays contiguous and the draw range stays one call.
        const j = --this.active;
        if (j !== i) this.copySlot(j, i);
        continue;
      }
      this.life[i] = nl;
      const d = Math.max(0, 1 - this.drag[i]! * dt);
      this.vx[i] = this.vx[i]! * d;
      this.vy[i] = this.vy[i]! * d + g * this.grav[i]! * dt;
      this.vz[i] = this.vz[i]! * d;
      this.px[i] = this.px[i]! + this.vx[i]! * dt;
      this.py[i] = this.py[i]! + this.vy[i]! * dt;
      this.pz[i] = this.pz[i]! + this.vz[i]! * dt;
      i++;
    }
  }

  private copySlot(from: number, to: number): void {
    this.px[to] = this.px[from]!; this.py[to] = this.py[from]!; this.pz[to] = this.pz[from]!;
    this.vx[to] = this.vx[from]!; this.vy[to] = this.vy[from]!; this.vz[to] = this.vz[from]!;
    this.life[to] = this.life[from]!; this.maxLife[to] = this.maxLife[from]!;
    this.size0[to] = this.size0[from]!; this.size1[to] = this.size1[from]!;
    this.cr[to] = this.cr[from]!; this.cg[to] = this.cg[from]!; this.cb[to] = this.cb[from]!;
    this.grav[to] = this.grav[from]!; this.drag[to] = this.drag[from]!;
  }

  /** Write the live particles into the vertex buffers. One pass, four vertices
   *  each, no allocation. */
  flush(): void {
    const n = this.active;
    for (let i = 0; i < n; i++) {
      const t = 1 - this.life[i]! / this.maxLife[i]!;
      const s = this.size0[i]! + (this.size1[i]! - this.size0[i]!) * t;
      // Alpha holds flat for the first third and then falls: a particle that
      // starts fading the instant it is born never reads as solid.
      const a = t < 0.34 ? 1 : 1 - (t - 0.34) / 0.66;
      const x = this.px[i]!, y = this.py[i]!, z = this.pz[i]!;
      const r = this.cr[i]!, g = this.cg[i]!, b = this.cb[i]!;
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v) * 3;
        this.centre[o + 0] = x; this.centre[o + 1] = y; this.centre[o + 2] = z;
        this.colour[o + 0] = r; this.colour[o + 1] = g; this.colour[o + 2] = b;
        this.size[i * 4 + v] = s;
        this.alpha[i * 4 + v] = a;
      }
    }
    this.geometry.getAttribute('aCentre').needsUpdate = true;
    this.geometry.getAttribute('aColour').needsUpdate = true;
    this.geometry.getAttribute('aSize').needsUpdate = true;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
    // The draw range is what keeps a half-empty pool from costing a full one:
    // dead slots are never visited by the rasteriser at all.
    this.geometry.setDrawRange(0, n * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export class ParticleSystem {
  private readonly spark: Pool;
  private readonly dust: Pool;
  private lastTime = -1;
  /** Seconds since the previous frame, for emitters to scale their rates by.
   *  Zero on every call after the first in a frame. */
  dt = 0;

  constructor(capacity: number) {
    // Sparks outnumber dust: a drift throws a continuous stream, dust comes in
    // puffs. Two thirds / one third measured against eight karts drifting.
    this.spark = new Pool(Math.max(16, Math.round(capacity * 0.66)), true);
    this.dust = new Pool(Math.max(16, Math.round(capacity * 0.34)), false);
  }

  get meshes(): THREE.Mesh[] {
    return [this.dust.mesh, this.spark.mesh];
  }

  /** Live particle counts, for the harness. */
  get counts(): { spark: number; dust: number } {
    return { spark: this.spark.count, dust: this.dust.count };
  }

  /**
   * Advance the pools once per frame.
   *
   * Every kart view calls this; only the first call at a given `time` does any
   * work. Gating on the time value rather than on a frame counter means the
   * system cannot be double-stepped by a second view, and cannot be stepped at
   * all while the simulation is paused.
   */
  frame(time: number): void {
    if (time === this.lastTime) {
      this.dt = 0;
      return;
    }
    // Clamped: a tab that was backgrounded for four seconds must not teleport
    // every live particle to the horizon on the frame it comes back.
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    this.dt = dt;
    if (dt > 0) {
      this.spark.update(dt);
      this.dust.update(dt);
    }
  }

  /** Called once after every view has emitted, to upload the buffers. */
  flush(): void {
    this.spark.flush();
    this.dust.flush();
  }

  emit(
    kind: PoolKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number,
    size0: number, size1: number,
    r: number, g: number, b: number,
    gravity: number,
    drag: number,
  ): void {
    const pool = kind === 'spark' ? this.spark : this.dust;
    pool.emit(x, y, z, vx, vy, vz, life, size0, size1, r, g, b, gravity, drag);
  }

  dispose(): void {
    this.spark.dispose();
    this.dust.dispose();
  }
}
