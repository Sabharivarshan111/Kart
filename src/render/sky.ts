import * as THREE from 'three';
import type { Theme } from '../core/palette.ts';

/**
 * The sky: a two-stop vertical gradient banded to match the cel ramp, plus a
 * hard-edged sun disc.
 *
 * Drawn on an inverted sphere that follows the camera, and kept out of the
 * G-buffer — the sky has no surface for a crease to be on, and giving it a real
 * depth would put an ink line along the horizon where the fog is supposed to
 * take over. The G-buffer's clear value stands in for it instead.
 */

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // Depth forced to the far plane so the sky never occludes anything, no
    // matter how the sphere is scaled.
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform float uBands;
  varying vec3 vDir;

  void main() {
    float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
    // Banded, like everything else. A smooth sky gradient behind a banded world
    // is the one place the cel look most obviously breaks.
    float q = floor(pow(h, 0.75) * uBands) / max(1.0, uBands - 1.0);
    vec3 colour = mix(uHorizon, uTop, clamp(q, 0.0, 1.0));

    // Hard sun disc with one halo step. No falloff: a soft glow here reads as a
    // lens artefact rather than as part of the drawing.
    float sunDot = dot(normalize(vDir), normalize(uSunDir));
    colour = mix(colour, uSunColour * 0.86, step(0.9965, sunDot));
    colour = mix(colour, uSunColour * 0.5, step(0.992, sunDot) * step(sunDot, 0.9965) * 0.55);

    gl_FragColor = vec4(colour, 1.0);
  }
`;

export function makeSky(theme: Theme, bands: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color().setHex(theme.skyTop, THREE.SRGBColorSpace) },
      uHorizon: { value: new THREE.Color().setHex(theme.skyHorizon, THREE.SRGBColorSpace) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColour: { value: new THREE.Color().setHex(theme.sun, THREE.SRGBColorSpace) },
      uBands: { value: bands + 2 },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  // Drawn first, so everything else overwrites it rather than blending with it.
  mesh.renderOrder = -1000;
  return mesh;
}

export function setSkySun(sky: THREE.Mesh, dir: THREE.Vector3): void {
  const mat = sky.material as THREE.ShaderMaterial;
  (mat.uniforms.uSunDir!.value as THREE.Vector3).copy(dir);
}
