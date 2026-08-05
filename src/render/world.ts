import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { WallKind } from '../core/contracts.ts';
import type { TrackSpec } from '../core/contracts.ts';
import { Rng } from '../core/rng.ts';
import type { Theme } from '../core/palette.ts';
import { buildCentreline } from '../track/centreline.ts';
import { buildTrackMeshes } from '../track/mesh.ts';
import { TrackSurface } from '../track/surface.ts';
import { LAYER_OUTLINE, OBJECT_IDS, makeCelMaterial, tagGeometry } from './celmaterial.ts';
import { MeshBuilder } from './geombuild.ts';
import { OutlineSystem } from './outline.ts';
import { makeSky, setSkySun } from './sky.ts';

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

  private readonly disposables: { dispose(): void }[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly sky: THREE.Mesh;
  /** Kept for the harness so tests can assert instances are actually spread
   *  rather than piled at the origin (brief §3: assert correct, not present). */
  readonly sceneryMesh: THREE.InstancedMesh | null = null;

  constructor(spec: TrackSpec, theme: Theme, tierSceneryCount: number, trackDensity: number) {
    this.theme = theme;
    const cl = buildCentreline(spec);
    this.surface = new TrackSurface(cl);

    // Sun direction from the track's own elevation and azimuth. Every cel
    // material and the sky share this one vector.
    const el = spec.theme.sunElevation;
    const az = spec.theme.sunAzimuth;
    this.sunDirection.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    this.sunDirection.normalize();

    this.outlines = new OutlineSystem(theme);
    this.disposables.push(this.outlines);

    this.sky = makeSky(theme, CONFIG.render.celBands);
    this.sky.scale.setScalar(900);
    setSkySun(this.sky, this.sunDirection);
    this.scene.add(this.sky);
    this.disposables.push(this.sky.geometry, this.sky.material as THREE.Material);

    const meshes = buildTrackMeshes(cl, theme, trackDensity);

    const surfaceMat = this.material({ vertexColours: true });
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

    const lineMat = this.material({ vertexColours: true });
    tagGeometry(meshes.startLine, OBJECT_IDS.track);
    const lineMesh = new THREE.Mesh(meshes.startLine, lineMat);
    lineMesh.frustumCulled = false;
    this.scene.add(lineMesh);
    this.disposables.push(meshes.startLine);

    this.sceneryMesh = this.buildScenery(cl.length, tierSceneryCount);
  }

  private material(opts: Parameters<typeof makeCelMaterial>[1]): THREE.ShaderMaterial {
    const m = makeCelMaterial(this.theme, opts);
    (m.uniforms.uSunDir!.value as THREE.Vector3).copy(this.sunDirection);
    this.materials.push(m);
    this.disposables.push(m);
    return m;
  }

  /**
   * Roadside scenery as a single InstancedMesh.
   *
   * Bug class 7 is exactly here: the cel and G-buffer vertex shaders are
   * hand-written, so they apply `instanceMatrix` themselves. If they did not,
   * all of these would draw stacked on the origin — and a test that counts them
   * would still pass, which is why `harness.stats()` reports their bounding box
   * spread rather than their count.
   */
  private buildScenery(lapLength: number, count: number): THREE.InstancedMesh | null {
    if (count <= 0) return null;
    const b = new MeshBuilder();
    // A tapered post with a wider cap: reads as a marker, a tree or a mast
    // depending on the theme's colours, and costs 60 triangles.
    b.box(0, 1.6, 0, 0.46, 3.2, 0.46, this.theme.scenery, 0.55, 0.55);
    b.box(0, 3.5, 0, 1.5, 1.5, 1.5, this.theme.sceneryAlt, 0.35, 0.35);
    const geo = tagGeometry(b.build(), OBJECT_IDS.scenery);
    this.disposables.push(geo);

    const mat = this.material({ vertexColours: true });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;

    // Fixed seed, not the session seed: scenery placement must be identical in
    // every named screenshot regardless of what the gameplay RNG is doing.
    const rng = new Rng(0x5ce4e27);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const p = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < count; i++) {
      const u = (i / count) * lapLength + rng.range(-4, 4);
      const side = i % 2 === 0 ? -1 : 1;
      const station = this.surface.stationAt(u);
      const off =
        station.halfWidth +
        CONFIG.track.vergeWidth +
        CONFIG.track.wallThickness +
        rng.range(1.5, 9.0);
      this.surface.pointAt(u, 0, p);
      pos.set(p.x + station.rx * off * side, p.y - 0.15, p.z + station.rz * off * side);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      const s = rng.range(0.7, 1.5);
      scl.set(s, rng.range(0.8, 1.8), s);
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

  followCamera(camera: THREE.Camera): void {
    this.sky.position.copy(camera.position);
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
