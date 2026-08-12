import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { WallKind } from '../core/contracts.ts';
import type { TrackSpec } from '../core/contracts.ts';
import { smoothstep } from '../core/mathx.ts';
import { Rng } from '../core/rng.ts';
import type { Theme } from '../core/palette.ts';
import { buildCentreline } from '../track/centreline.ts';
import { buildTrackMeshes } from '../track/mesh.ts';
import { TrackSurface } from '../track/surface.ts';
import {
  LAYER_BEAUTY_ONLY,
  LAYER_OUTLINE,
  OBJECT_IDS,
  makeCelMaterial,
  tagGeometry,
} from './celmaterial.ts';
import { MeshBuilder } from './geombuild.ts';
import { OutlineSystem } from './outline.ts';
import { ParticleSystem } from './particles.ts';
import { buildSceneryGeometry, sceneryKitSpec } from './scenery.ts';
import { makeShadowMaterial } from './shadow.ts';
import { makeSky, setSkyClouds, setSkySun } from './sky.ts';

/**
 * Scene assembly for a track. Everything here is generated at runtime from the
 * track spec and the palette — no meshes, no textures, no files.
 *
 * Owns disposal too. Track themes are applied at load and never hot-swapped
 * (ARCHITECTURE.md §3.2): selecting a track stores the choice and reloads,
 * because re-theming live means rebuilding and disposing every material and one
 * missed dispose is a leak that only surfaces after six races.
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly surface: TrackSurface;
  readonly theme: Theme;
  readonly outlines: OutlineSystem;
  readonly sunDirection = new THREE.Vector3();
  readonly particles: ParticleSystem;

  /** Horizontal direction a shadow falls in, and how far it stretches. Derived
   *  once from the sun so every kart's contact shadow agrees with every other's
   *  and with the cel ramp's terminator. */
  readonly shadowDirX: number;
  readonly shadowDirZ: number;
  readonly shadowStretch: number;
  /** Metres of horizontal offset per metre of height above the ground. */
  readonly shadowOffsetPerMetre: number;

  private readonly disposables: { dispose(): void }[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly sky: THREE.Mesh;
  /** Height of the flat plain the terrain shell sits at, decided in
   *  `buildTerrain` and read by `buildScenery` — a prop placed at the road's own
   *  height stands in mid-air over that plain, because the embankment skirt
   *  drops vertically from the corridor edge. */
  private groundY = 0;
  /** Kept for the harness so tests can assert instances are actually spread
   *  rather than piled at the origin (brief §3: assert correct, not present). */
  readonly sceneryMesh: THREE.InstancedMesh | null = null;

  constructor(
    spec: TrackSpec,
    theme: Theme,
    tierSceneryCount: number,
    trackDensity: number,
    tier?: { maxParticles: number; cloudAmount: number },
  ) {
    this.theme = theme;
    const cl = buildCentreline(spec);
    this.surface = new TrackSurface(cl);

    // Sun direction from the track's own elevation and azimuth. Every cel
    // material and the sky share this one vector.
    const el = spec.theme.sunElevation;
    const az = spec.theme.sunAzimuth;
    this.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    this.sunDirection.normalize();

    // A shadow falls away from the sun, along the sun's ground projection.
    const hx = -this.sunDirection.x;
    const hz = -this.sunDirection.z;
    const hl = Math.hypot(hx, hz) || 1;
    this.shadowDirX = hx / hl;
    this.shadowDirZ = hz / hl;
    // 1/sin(elevation), clamped. A 16° sun would otherwise throw a 7 m smear
    // that stops reading as belonging to the kart at all.
    const sinEl = Math.max(0.28, this.sunDirection.y);
    this.shadowStretch = Math.min(CONFIG.render.shadowMaxStretch, 1 / sinEl);
    this.shadowOffsetPerMetre = Math.min(2.4, (hl / sinEl) * 0.6);

    this.outlines = new OutlineSystem(theme);
    this.disposables.push(this.outlines);

    this.particles = new ParticleSystem(tier?.maxParticles ?? 420);
    for (const m of this.particles.meshes) this.scene.add(m);
    this.disposables.push(this.particles);

    this.sky = makeSky(theme, CONFIG.render.celBands);
    this.sky.scale.setScalar(900);
    setSkySun(this.sky, this.sunDirection);
    setSkyClouds(this.sky, tier?.cloudAmount ?? 1);
    this.scene.add(this.sky);
    this.disposables.push(this.sky.geometry, this.sky.material as THREE.Material);

    const meshes = buildTrackMeshes(cl, theme, trackDensity);

    const surfaceMat = this.material({ vertexColours: true, ramp: 'soft' });
    tagGeometry(meshes.surface, OBJECT_IDS.track);
    const surfaceMesh = new THREE.Mesh(meshes.surface, surfaceMat);
    surfaceMesh.frustumCulled = false;
    this.scene.add(surfaceMesh);
    this.disposables.push(meshes.surface);

    // Walls are double-sided. Only the inner face is emitted as geometry, so
    // with FrontSide the near barrier is culled when the camera is outside it —
    // and what remained on screen was its inverted hull, drawn as a solid ink
    // slab across a third of the frame.
    const wallMat = this.material({ vertexColours: true, side: THREE.DoubleSide });
    tagGeometry(meshes.walls, OBJECT_IDS.wall);
    const wallMesh = new THREE.Mesh(meshes.walls, wallMat);
    wallMesh.frustumCulled = false;
    this.scene.add(wallMesh);
    this.disposables.push(meshes.walls);
    // No inverted hull on the walls or the road. The hull trick assumes a
    // closed mesh: expanding an open shell produces a shape that is not a
    // silhouette of anything, and a hull around a 700 m ribbon of road would be
    // one enormous outline around the whole circuit. The Sobel handles both —
    // that is exactly the case the object-id channel exists for.

    const lineMat = this.material({ vertexColours: true, ramp: 'soft' });
    tagGeometry(meshes.startLine, OBJECT_IDS.track);
    const lineMesh = new THREE.Mesh(meshes.startLine, lineMat);
    lineMesh.frustumCulled = false;
    this.scene.add(lineMesh);
    this.disposables.push(meshes.startLine);

    // Terrain before scenery: it decides the ground height every post stands on.
    this.buildTerrain(cl, trackDensity);
    this.sceneryMesh = this.buildScenery(cl.length, tierSceneryCount);
  }

  /**
   * The world outside the barriers.
   *
   * Before this existed the track floated in the sky dome: every camera that
   * looked past the walls — a trackside replay, a jump, anything overhead —
   * filled its lower half with banded sky, and no amount of work on the road
   * itself could survive that.
   *
   * Two pieces, both generated from the same stations the road is:
   *
   *  - an **embankment skirt** hanging from the outer edge of each ring down to
   *    the ground plane, so the corridor is a raised bed rather than a ribbon
   *    with nothing under it. It hangs from the same lateral offset the wall cap
   *    ends at, so there is no seam to line up;
   *  - a **ground shell**, a warped grid that is dead flat anywhere near the
   *    circuit and lifts into hills further out. The flat margin is not a
   *    nicety: relief that reaches the corridor pokes through the road.
   *
   * The grid is warped (t² spacing) so the cells are small near the track, where
   * they are seen close up, and enormous at 700 m, where one cell covers more
   * screen than the whole infield.
   */
  private buildTerrain(cl: ReturnType<typeof buildCentreline>, trackDensity: number): void {
    const stations = cl.stations;
    const m = stations.length;
    if (m < 3) return;
    const step = Math.max(1, Math.round(trackDensity));
    const verge = CONFIG.track.vergeWidth;
    const wallT = CONFIG.track.wallThickness;

    /** Outer edge of the corridor at a station, on the given side. */
    const edge = (s: (typeof stations)[number], side: number, out: THREE.Vector3): void => {
      const off = (s.halfWidth + verge + (s.wall === WallKind.Open ? 0 : wallT)) * side;
      out.set(s.x + s.rx * off, s.y + off * Math.tan(s.bank), s.z + s.rz * off);
    };

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();

    // The ground sits below the lowest point the skirt hangs from. 1.6 m: deep
    // enough that a banked outer edge never dips under it, shallow enough that
    // the embankment does not read as a plinth.
    let lowest = Infinity;
    for (const s of stations) {
      const drop = Math.abs((s.halfWidth + verge + wallT) * Math.tan(s.bank));
      lowest = Math.min(lowest, s.y - drop);
    }
    const groundY = lowest - 1.6;
    this.groundY = groundY;

    const g = new MeshBuilder();
    const ringCount = Math.floor(m / step);
    for (let r = 0; r < ringCount; r++) {
      const s0 = stations[(r * step) % m]!;
      const s1 = stations[((r + 1) * step) % m]!;
      for (const side of [-1, 1] as const) {
        edge(s0, side, a);
        edge(s1, side, b);
        c.set(b.x, groundY, b.z);
        d.set(a.x, groundY, a.z);
        // Wound so the face points *away* from the track on both sides. The
        // station's right vector is (tz, -tx); taking a,b,c,d in that order on
        // the right-hand side gives the opposite, so the two sides are reversed
        // relative to each other. Get this wrong and the embankment is culled
        // and the track floats again, but only when seen from outside.
        if (side > 0) g.quad(b, a, d, c, this.theme.scenery);
        else g.quad(a, b, c, d, this.theme.scenery);
      }
    }

    // --- the ground shell ---------------------------------------------------
    const cx = (cl.bounds.minX + cl.bounds.maxX) / 2;
    const cz = (cl.bounds.minZ + cl.bounds.maxZ) / 2;
    const trackSpan = Math.max(cl.bounds.maxX - cl.bounds.minX, cl.bounds.maxZ - cl.bounds.minZ);
    // 700 m: past this the fog is fully saturated on every theme (the thinnest
    // is 0.0035/m, which is opaque by ~520 m), so more ground is invisible cost.
    const radius = Math.max(700, trackSpan);
    const N = 40;

    // Distance to the corridor, sampled every 4th station. The relief has to be
    // zero anywhere near the road or it pushes up through it, and a coarse
    // sample is plenty for a field that only gates a smoothstep.
    const sample = Math.max(1, Math.round(4 / CONFIG.track.stationSpacing));
    const distToTrack = (x: number, z: number): number => {
      let best = Infinity;
      for (let i = 0; i < m; i += sample) {
        const s = stations[i]!;
        const dx = x - s.x;
        const dz = z - s.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      return Math.sqrt(best);
    };

    // Deterministic hash noise — no Math.random anywhere in src/ (§5).
    const hash = (x: number, z: number): number => {
      const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    const noise = (x: number, z: number): number => {
      const xi = Math.floor(x);
      const zi = Math.floor(z);
      const xf = x - xi;
      const zf = z - zi;
      const u = xf * xf * (3 - 2 * xf);
      const v = zf * zf * (3 - 2 * zf);
      const n00 = hash(xi, zi);
      const n10 = hash(xi + 1, zi);
      const n01 = hash(xi, zi + 1);
      const n11 = hash(xi + 1, zi + 1);
      return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
    };

    const warp = (i: number): number => {
      const t = (i / N) * 2 - 1;
      return Math.sign(t) * t * t * radius;
    };

    const gx = new Float32Array((N + 1) * (N + 1));
    const gy = new Float32Array((N + 1) * (N + 1));
    const gz = new Float32Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const x = cx + warp(i);
        const z = cz + warp(j);
        const dist = distToTrack(x, z);
        // Flat out to 90 m, full relief by 320 m. Below 90 m a hill can reach
        // the corridor through the skirt; the validator would not catch it
        // because it is not track geometry at all.
        const amp = smoothstep(90, 320, dist);
        const h = noise(x * 0.0055, z * 0.0055) * 0.72 + noise(x * 0.017, z * 0.017) * 0.28;
        const k = j * (N + 1) + i;
        gx[k] = x;
        gz[k] = z;
        gy[k] = groundY + (h - 0.35) * 62 * amp;
      }
    }

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k00 = j * (N + 1) + i;
        const k10 = k00 + 1;
        const k11 = k00 + N + 2;
        const k01 = k00 + N + 1;
        a.set(gx[k00]!, gy[k00]!, gz[k00]!);
        b.set(gx[k10]!, gy[k10]!, gz[k10]!);
        c.set(gx[k11]!, gy[k11]!, gz[k11]!);
        d.set(gx[k01]!, gy[k01]!, gz[k01]!);
        // Colour by height above the plain, flat per cell so the cel look
        // holds: low ground is the theme's grass, the shoulders are sand and
        // the high ground is the scenery colour the sky's ridges also use.
        const rise = (a.y + b.y + c.y + d.y) / 4 - groundY;
        const hex =
          rise > 16 ? this.theme.sceneryAlt : rise > 4.5 ? this.theme.sand : this.theme.grass;
        g.quad(a, b, c, d, hex);
      }
    }

    const geo = tagGeometry(g.build(), OBJECT_IDS.terrain);
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, this.material({ vertexColours: true, ramp: 'soft' }));
    mesh.frustumCulled = false;
    // Behind everything: the ground can never occlude the track, and drawing it
    // first lets the depth buffer reject most of its fragments.
    mesh.renderOrder = -10;
    this.scene.add(mesh);
    // No inverted hull, for the same reason the road has none: a hull around a
    // 1.4 km² shell is one outline around the entire world.
  }

  private material(opts: Parameters<typeof makeCelMaterial>[1]): THREE.ShaderMaterial {
    const m = makeCelMaterial(this.theme, opts);
    (m.uniforms.uSunDir!.value as THREE.Vector3).copy(this.sunDirection);
    this.materials.push(m);
    this.disposables.push(m);
    return m;
  }

  /**
   * Roadside scenery as a single InstancedMesh, built from the kit the theme
   * names (`render/scenery.ts`).
   *
   * Bug class 7 is exactly here: the cel and G-buffer vertex shaders are
   * hand-written, so they apply `instanceMatrix` themselves. If they did not,
   * all of these would draw stacked on the origin — and a test that counts them
   * would still pass, which is why `harness.stats()` reports their bounding box
   * spread rather than their count.
   */
  private buildScenery(lapLength: number, count: number): THREE.InstancedMesh | null {
    if (count <= 0) return null;

    // The kit is named by the theme, so "what this place looks like" and "what
    // colour this place is" are decided in the same file. One geometry, one
    // draw call, `count` instances.
    const kit = sceneryKitSpec(this.theme.sceneryKit);
    const geo = tagGeometry(buildSceneryGeometry(this.theme), OBJECT_IDS.scenery);
    this.disposables.push(geo);

    const mat = this.material({ vertexColours: true });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;

    // Fixed seed, not the session seed: scenery placement must be identical in
    // every named screenshot regardless of what the gameplay RNG is doing.
    const rng = new Rng(0x5ce4e27);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const p = { x: 0, y: 0, z: 0 };

    const wallLine = CONFIG.track.vergeWidth + CONFIG.track.wallThickness;

    for (let i = 0; i < count; i++) {
      // Stratified along the lap rather than random, then jittered. Pure
      // rejection sampling leaves visible gaps at 90 instances (the low tier),
      // and a gap in a tree line reads as a missing chunk of world.
      const u = (i / count) * lapLength + rng.range(-4, 4);
      const side = i % 2 === 0 ? -1 : 1;
      const station = this.surface.stationAt(u);
      const band = rng.range(kit.minOffset, kit.maxOffset);
      const off = station.halfWidth + wallLine + band;
      this.surface.pointAt(u, 0, p);

      // Ground height. The terrain's plain is flat at `groundY` from the
      // corridor edge outwards, so a prop sitting at the road's height floats.
      // Blending over the first 14 m keeps the near props tucked against the
      // barrier (where they are half hidden by it anyway) and drops the far ones
      // onto the plain they are actually standing on. Before this every palm on
      // an elevated section stood on nothing.
      const t = Math.min(1, band / 14);
      const y = p.y + (this.groundY - p.y) * t - kit.sink;

      pos.set(p.x + station.rx * off * side, y, p.z + station.rz * off * side);
      // Lean is per-kit: grown things lean, built things do not. The lean is
      // applied before the yaw so a palm leans in a random compass direction
      // rather than always the same way relative to the road.
      euler.set(rng.range(-kit.tilt, kit.tilt), rng.range(0, Math.PI * 2), rng.range(-kit.tilt, kit.tilt));
      q.setFromEuler(euler);
      const s = rng.range(kit.scaleMin, kit.scaleMax);
      scl.set(s, s * rng.range(kit.heightMin, kit.heightMax), s);
      m4.compose(pos, q, scl);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    // Deliberately no inverted hull on scenery. A constant-2.4-pixel outline is
    // right for a kart filling a third of the screen and catastrophic for a
    // post 90 m away that is six pixels wide — the outline swallows the object
    // and the tree line renders as a row of black cut-outs. Hulls are for the
    // near, hero objects (karts and items); the Sobel silhouettes everything
    // else against the sky, at a weight that scales with what is actually
    // there.
    return mesh;
  }

  /** Tunnels need the sky hidden or it shows through the roof's open ends. */
  hasTunnel(spec: TrackSpec): boolean {
    return spec.stretches.some((s) => s.wall === WallKind.Tunnel);
  }

  /**
   * Called once per rendered frame, after every view has updated.
   *
   * It moves the sky onto the camera — and it is also the one place in the
   * frame that is guaranteed to run exactly once *after* every emitter has had
   * its turn, which is where the particle buffers have to be uploaded. A view
   * cannot do it: there are eight of them and none knows it is the last.
   */
  followCamera(camera: THREE.Camera): void {
    this.sky.position.copy(camera.position);
    this.particles.flush();
  }

  /** A contact-shadow material bound to this theme, registered for disposal.
   *  One per kart, because the fade with height is a per-kart uniform. */
  shadowMaterial(): THREE.ShaderMaterial {
    const m = makeShadowMaterial(this.theme);
    this.disposables.push(m);
    return m;
  }

  /** Put an object on the layer that the beauty pass draws and the G-buffer
   *  ignores. Blended effects belong here; see `LAYER_BEAUTY_ONLY`. */
  addBeautyOnly(object: THREE.Object3D): void {
    object.layers.set(LAYER_BEAUTY_ONLY);
    this.scene.add(object);
  }

  add(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  /** A cel material bound to this world's theme and sun, registered for
   *  disposal. Karts, items and effects all come through here so that nothing
   *  can quietly construct a material with a different sun. */
  celMaterial(opts: Parameters<typeof makeCelMaterial>[1]): THREE.ShaderMaterial {
    return this.material(opts);
  }

  track(object: THREE.Object3D): void {
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.layers.isEnabled(LAYER_OUTLINE) === false) {
        this.disposables.push(mesh.geometry);
      }
    });
  }

  resize(heightPx: number, fovDeg: number): void {
    this.outlines.resize(heightPx, fovDeg);
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // A double dispose is harmless; a missed one is the leak that shows up
        // after six races, so this never swallows the loop itself.
      }
    }
    this.disposables.length = 0;
    this.scene.clear();
  }
}
