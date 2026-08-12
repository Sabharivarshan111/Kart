import * as THREE from 'three';
import type { Theme } from '../core/palette.ts';

/**
 * The sky.
 *
 * Drawn on an inverted sphere that follows the camera, and kept out of the
 * G-buffer — the sky has no surface for a crease to be on, and giving it a real
 * depth would put an ink line along the horizon where the fog is supposed to
 * take over. The G-buffer's clear value stands in for it instead.
 *
 * What is here beyond a gradient, and why:
 *
 *  - **Cloud form.** A two-stop banded gradient reads as a backdrop card. The
 *    clouds are value-noise fbm evaluated on a *cloud plane* — the view
 *    direction divided by its own height — so they converge toward the horizon
 *    the way real cloud cover does, instead of wrapping the dome evenly. They
 *    are quantised into three coverage steps and given a lit edge on the sun
 *    side, so they are drawn shapes rather than a soft render.
 *  - **Horizon haze.** A bright band hugging the horizon, strongest toward the
 *    sun. This is the single cheapest cue that there is air between here and the
 *    distance.
 *  - **Distant land.** Below the horizon the dome does not carry on banding the
 *    sky; it becomes a hazed land colour with a low ridge line noised along the
 *    azimuth. Real terrain geometry covers the near field, but a track on an
 *    embankment still shows dome below the horizon at the sides, and a band of
 *    sky-blue down there is instantly wrong.
 *
 * Nothing here is animated. The clouds are static on purpose: a drifting sky
 * makes every named screenshot differ from the last, and the sphere follows the
 * camera so there is no parallax to gain anyway.
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
  uniform vec3 uLand;
  uniform vec3 uLandFar;
  uniform float uBands;
  uniform float uCloud;
  varying vec3 vDir;

  // Hash-based value noise. No texture, no external asset — the brief's hard
  // rule — and cheap enough to run three octaves over a full-screen dome.
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    // Smoothstep interpolation: linear interpolation of a value lattice leaves
    // visible diamond creases along the cell diagonals.
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    v += 0.55 * valueNoise(p);
    v += 0.30 * valueNoise(p * 2.17 + 11.3);
    v += 0.15 * valueNoise(p * 4.41 + 27.7);
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    float sunDot = dot(dir, normalize(uSunDir));

    // --- banded vertical gradient -----------------------------------------
    float up = clamp(h, 0.0, 1.0);
    // Banded, like everything else. A smooth sky gradient behind a banded world
    // is the one place the cel look most obviously breaks.
    float q = floor(pow(up, 0.62) * uBands) / max(1.0, uBands - 1.0);
    vec3 colour = mix(uHorizon, uTop, clamp(q, 0.0, 1.0));

    // --- horizon haze ------------------------------------------------------
    // Strongest at the horizon and toward the sun; two steps, so it is a band
    // of light rather than a blur.
    float haze = (1.0 - smoothstep(0.0, 0.30, abs(h))) * (0.45 + 0.55 * max(0.0, sunDot));
    colour = mix(colour, uHorizon * 1.16, floor(haze * 3.0) / 3.0 * 0.8);

    // --- clouds ------------------------------------------------------------
    // Projected onto a plane above the camera: dir.xz / dir.y. Clamped away
    // from zero or the projection blows up at the horizon and the last band of
    // cloud smears to the width of the screen.
    if (uCloud > 0.0 && h > 0.0) {
      vec2 cp = dir.xz / max(h, 0.10) * 0.55;
      float n = fbm(cp);
      // Coverage quantised to three steps: body, edge, and a thin lit rim on
      // the sun side. Hard steps, because a soft cloud in a cel frame reads as
      // the renderer failing rather than as weather.
      float cover = smoothstep(0.50, 0.78, n);
      float body = step(0.30, cover);
      float core = step(0.72, cover);
      // Fade out toward the horizon, where the projection stretches each cloud
      // to a horizontal streak, and toward the zenith seam.
      float band = smoothstep(0.04, 0.30, h) * (1.0 - smoothstep(0.72, 1.0, h));
      float amount = (body * 0.62 + core * 0.38) * band * uCloud;
      // Lit on the sun side, shaded away from it.
      vec3 cloudLit = mix(uHorizon * 1.30, uSunColour, 0.45 + 0.35 * max(0.0, sunDot));
      vec3 cloudDark = mix(uTop, uHorizon, 0.55) * 0.94;
      vec3 cloud = mix(cloudDark, cloudLit, core);
      colour = mix(colour, cloud, clamp(amount, 0.0, 1.0));
    }

    // --- distant land below the horizon ------------------------------------
    // A low ridge noised along the azimuth, hazed into the horizon colour. Two
    // depths of it, so there is a sense of somewhere rather than a floor.
    float az = atan(dir.z, dir.x);
    float ridgeFar = (valueNoise(vec2(az * 2.6, 0.5)) - 0.5) * 0.055;
    float ridgeNear = (valueNoise(vec2(az * 5.3, 9.5)) - 0.5) * 0.030 - 0.030;
    colour = mix(colour, uLandFar, step(h, ridgeFar));
    colour = mix(colour, uLand, step(h, ridgeNear));

    // Hard sun disc with one halo step. No falloff: a soft glow here reads as a
    // lens artefact rather than as part of the drawing.
    colour = mix(colour, uSunColour * 0.86, step(0.9965, sunDot));
    colour = mix(colour, uSunColour * 0.5, step(0.992, sunDot) * step(sunDot, 0.9965) * 0.55);

    gl_FragColor = vec4(colour, 1.0);
  }
`;

export function makeSky(theme: Theme, bands: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const horizon = new THREE.Color().setHex(theme.skyHorizon, THREE.SRGBColorSpace);
  const scenery = new THREE.Color().setHex(theme.scenery, THREE.SRGBColorSpace);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color().setHex(theme.skyTop, THREE.SRGBColorSpace) },
      uHorizon: { value: horizon },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColour: { value: new THREE.Color().setHex(theme.sun, THREE.SRGBColorSpace) },
      // The far ridge is mostly haze — 78% of the way to the horizon colour —
      // and the near one only 42%. That difference *is* the depth cue; make
      // them the same and the two ridges collapse into one silhouette.
      uLandFar: { value: scenery.clone().lerp(horizon, 0.78) },
      uLand: { value: scenery.clone().lerp(horizon, 0.42) },
      uBands: { value: bands + 2 },
      uCloud: { value: 1 },
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

/** Cloud cover, 0..1. The quality tier turns it off on the lowest tier, where
 *  three octaves of noise over a full-screen dome is the single most expensive
 *  thing in the frame. */
export function setSkyClouds(sky: THREE.Mesh, amount: number): void {
  const mat = sky.material as THREE.ShaderMaterial;
  mat.uniforms.uCloud!.value = amount;
}
