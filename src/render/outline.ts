import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { Theme } from '../core/palette.ts';
import { LAYER_OUTLINE, computeSmoothNormals } from './celmaterial.ts';

/**
 * Inverted-hull outlines.
 *
 * The mesh is drawn a second time, expanded along a **smoothed** normal and
 * with front faces culled, so only the expanded backfaces survive around the
 * silhouette.
 *
 * The expansion is **a constant number of screen pixels**, not a constant
 * number of world units. Expanding by world units makes the line thin out with
 * distance until it vanishes, and fat up in close-ups until the kart looks
 * shrink-wrapped in ink. Converting pixels to view-space units needs the view
 * depth, which is why the offset is applied in view space rather than in object
 * space.
 *
 * Hulls go on `LAYER_OUTLINE`, which the G-buffer pass excludes. Without that
 * exclusion the Sobel draws the same silhouette a second time and the two lines
 * disagree by a pixel, which reads as a smear rather than as a line.
 */

const OUTLINE_VERTEX = /* glsl */ `
  attribute vec3 aSmoothNormal;
  uniform float uPixels;
  uniform float uScreenHeight;
  uniform float uTanHalfFov;
  uniform float uMinDepth;

  void main() {
    mat4 modelMat = modelMatrix;
    vec3 smoothNormal = aSmoothNormal;
    #ifdef USE_INSTANCING
      modelMat = modelMatrix * instanceMatrix;
      smoothNormal = mat3(instanceMatrix) * smoothNormal;
    #endif

    vec4 worldPos = modelMat * vec4(position, 1.0);
    vec4 viewPos = viewMatrix * worldPos;
    vec3 viewNormal = normalize(mat3(viewMatrix) * normalize(mat3(modelMat) * smoothNormal));

    // World units subtended by one screen pixel at this view depth. Clamped
    // away from the near plane: as -z approaches 0 this goes to zero and the
    // outline collapses on geometry touching the camera.
    float depth = max(uMinDepth, -viewPos.z);
    float unitsPerPixel = (2.0 * uTanHalfFov * depth) / uScreenHeight;

    viewPos.xyz += viewNormal * (uPixels * unitsPerPixel);
    gl_Position = projectionMatrix * viewPos;
  }
`;

const OUTLINE_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uInk;
  void main() {
    gl_FragColor = vec4(uInk, 1.0);
  }
`;

export class OutlineSystem {
  readonly material: THREE.ShaderMaterial;

  constructor(theme: Theme) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: OUTLINE_VERTEX,
      fragmentShader: OUTLINE_FRAGMENT,
      // Cull the front faces so what remains is the expanded shell behind the
      // object — the outline. FrontSide here draws a solid blob.
      side: THREE.BackSide,
      uniforms: {
        uPixels: { value: CONFIG.render.outlinePixels },
        uScreenHeight: { value: 1080 },
        uTanHalfFov: { value: Math.tan((CONFIG.camera.fovBase * Math.PI) / 360) },
        // 0.35 m: closer than the chase camera ever gets to a kart, so the
        // clamp never affects a normal frame and only catches the wall-scrape
        // case where a barrier passes through the near plane.
        uMinDepth: { value: 0.35 },
        uInk: { value: new THREE.Color().setHex(theme.ink, THREE.SRGBColorSpace) },
      },
    });
  }

  /** Build the outline twin of a mesh. The twin shares the geometry — only the
   *  material and the draw order differ — so this costs no extra memory. */
  attach(mesh: THREE.Mesh): THREE.Mesh {
    if (!mesh.geometry.getAttribute('aSmoothNormal')) {
      computeSmoothNormals(mesh.geometry);
    }
    const hull = new THREE.Mesh(mesh.geometry, this.material);
    hull.layers.set(LAYER_OUTLINE);
    hull.renderOrder = (mesh.renderOrder ?? 0) - 1;
    hull.frustumCulled = mesh.frustumCulled;
    mesh.add(hull);
    // The hull is a child, so it inherits the parent's transform and needs its
    // own identity — otherwise it picks up the parent's scale twice.
    hull.position.set(0, 0, 0);
    hull.quaternion.identity();
    hull.scale.set(1, 1, 1);
    return hull;
  }

  /** Instanced variant: the hull must be an InstancedMesh too, sharing the same
   *  instance matrices, or the outlines sit at the origin while the objects
   *  they belong to are elsewhere. */
  attachInstanced(mesh: THREE.InstancedMesh): THREE.InstancedMesh {
    if (!mesh.geometry.getAttribute('aSmoothNormal')) {
      computeSmoothNormals(mesh.geometry);
    }
    const hull = new THREE.InstancedMesh(mesh.geometry, this.material, mesh.count);
    hull.instanceMatrix = mesh.instanceMatrix;
    hull.layers.set(LAYER_OUTLINE);
    hull.renderOrder = (mesh.renderOrder ?? 0) - 1;
    hull.count = mesh.count;
    return hull;
  }

  resize(heightPx: number, fovDeg: number): void {
    this.material.uniforms.uScreenHeight!.value = heightPx;
    this.material.uniforms.uTanHalfFov!.value = Math.tan((fovDeg * Math.PI) / 360);
  }

  setThickness(pixels: number): void {
    this.material.uniforms.uPixels!.value = pixels;
  }

  dispose(): void {
    this.material.dispose();
  }
}
