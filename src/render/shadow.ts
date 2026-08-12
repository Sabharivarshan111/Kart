import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { Theme } from '../core/palette.ts';

/**
 * The contact shadow under a kart.
 *
 * Not a shadow map: a 1024² map costs more than the eight karts' geometry put
 * together on a phone, and a cel look wants a hard-edged shape anyway. What it
 * *is* is a projected blob — oriented to the surface normal, offset along the
 * sun's ground direction by the kart's height, and stretched along that
 * direction by 1/sin(elevation). A low sun therefore throws a long shadow that
 * leans away from it, which is most of what a real projection would have bought.
 *
 * It is **multiplied** into the beauty buffer rather than drawn as a grey disc.
 * The previous version was a flat translucent cylinder in the tyre colour, and
 * over a dark road it was *lighter* than the surface it was meant to be
 * darkening — a pale stain with an ink ring round it, because it also wrote the
 * G-buffer with an object id that disagreed with the road's. This writes no
 * G-buffer at all (it lives on the beauty-only layer) and can only ever darken.
 */

const SHADOW_VERTEX = /* glsl */ `
  varying vec2 vP;
  void main() {
    // The disc lies in the local XZ plane, so its own coordinates are the
    // radial ones. Scaling the mesh in local X and Z is what stretches the
    // shadow, and it still comes out round in the shader.
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHADOW_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform vec3 uShadow;
  uniform float uStrength;
  varying vec2 vP;

  void main() {
    float r = length(vP);
    if (r > 1.0) discard;
    // Two hard steps: a dark core and a lighter penumbra. A smooth falloff
    // reads as a blurred sprite; this reads as drawn.
    float a = r < 0.62 ? 1.0 : 0.55;
    gl_FragColor = vec4(mix(vec3(1.0), uShadow, a * uStrength), 1.0);
  }
`;

/** A unit-radius disc lying in the XZ plane, built as a fan. 18 sides: the
 *  silhouette is only ever seen flat against the ground, and the polygon edge
 *  stops being visible above about a dozen. */
export function makeShadowGeometry(): THREE.BufferGeometry {
  const sides = 18;
  const pos = new Float32Array((sides + 1) * 3);
  const idx = new Uint16Array(sides * 3);
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    pos[(i + 1) * 3 + 0] = Math.cos(a);
    pos[(i + 1) * 3 + 2] = Math.sin(a);
    idx[i * 3 + 0] = 0;
    idx[i * 3 + 1] = i + 1;
    idx[i * 3 + 2] = ((i + 1) % sides) + 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function makeShadowMaterial(theme: Theme): THREE.ShaderMaterial {
  // The shadow is tinted with the theme's ambient, because a shadow is lit by
  // the sky and nothing else. A neutral grey multiply reads as dirt.
  const tint = new THREE.Color().setHex(theme.ambient, THREE.SRGBColorSpace);
  const luma = 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b;
  tint.multiplyScalar(1 / Math.max(0.001, luma));
  return new THREE.ShaderMaterial({
    vertexShader: SHADOW_VERTEX,
    fragmentShader: SHADOW_FRAGMENT,
    // Multiply: dst × src. The result can only be darker than what is already
    // there, which is the one thing a shadow must be guaranteed to be.
    blending: THREE.MultiplyBlending,
    transparent: true,
    // Three warns on every boot without this — MultiplyBlending expects the
    // source colour to already carry its alpha. The shader below writes
    // `mix(vec3(1.0), shade, coverage)`, which is exactly that: full white
    // (a no-op multiply) where the shadow does not reach.
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uShadow: { value: tint.multiplyScalar(0.42) },
      uStrength: { value: CONFIG.render.shadowDarkness },
    },
  });
}
