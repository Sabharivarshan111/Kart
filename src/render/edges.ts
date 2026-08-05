import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { Theme } from '../core/palette.ts';

/**
 * The composite pass: Sobel over the G-buffer for interior lines, then the
 * screen-space speed effects.
 *
 * Three things are combined into one edge signal, because each catches
 * something the others cannot:
 *
 *  - **depth** gives silhouettes and anything in front of anything else;
 *  - **normal** gives creases on a single continuous surface;
 *  - **object id** gives two different objects meeting at the same depth *and*
 *    the same angle — a wheel against a chassis, a kart against a wall it is
 *    scraping. Neither of the other two sees that at all.
 *
 * Depth is compared **relatively** (Δd/d). An absolute threshold that looks
 * right on a kart 6 m away scribbles over every surface in the foreground and
 * finds nothing at all past 40 m, because the same physical step subtends a
 * different depth difference at different distances.
 *
 * The taps are spaced in **G-buffer texels**, which is the whole reason
 * `uTexel` exists rather than using screen pixels. Against a half-resolution
 * target, screen-pixel spacing samples the same texel nine times and returns a
 * gradient of exactly zero — silently no lines at all, on the platform you
 * least wanted to lose them.
 */

const COMPOSITE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D uBeauty;
  uniform sampler2D uGBuffer;
  uniform vec2 uTexel;          // one G-BUFFER texel, not one screen pixel
  uniform vec3 uInk;
  uniform float uDepthStrength;
  uniform float uNormalStrength;
  uniform float uIdStrength;
  uniform float uDepthThreshold;
  uniform float uNormalThreshold;
  uniform float uEdgesEnabled;

  // Speed effects
  uniform float uSpeedFactor;    // 0..1
  uniform float uBoostFactor;    // 0..1
  uniform float uChromatic;      // 0..1
  uniform float uStreaksEnabled;
  uniform float uVignette;

  varying vec2 vUv;

  vec3 octDecode(vec2 f) {
    f = f * 2.0 - 1.0;
    vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
    float t = max(-n.z, 0.0);
    n.x += n.x >= 0.0 ? -t : t;
    n.y += n.y >= 0.0 ? -t : t;
    return normalize(n);
  }

  void main() {
    vec3 colour = texture2D(uBeauty, vUv).rgb;

    if (uEdgesEnabled > 0.5) {
      // 3x3 neighbourhood, spaced one G-buffer texel apart.
      vec4 c  = texture2D(uGBuffer, vUv);
      vec4 l  = texture2D(uGBuffer, vUv + vec2(-uTexel.x, 0.0));
      vec4 r  = texture2D(uGBuffer, vUv + vec2( uTexel.x, 0.0));
      vec4 d  = texture2D(uGBuffer, vUv + vec2(0.0, -uTexel.y));
      vec4 u  = texture2D(uGBuffer, vUv + vec2(0.0,  uTexel.y));
      vec4 tl = texture2D(uGBuffer, vUv + vec2(-uTexel.x,  uTexel.y));
      vec4 tr = texture2D(uGBuffer, vUv + vec2( uTexel.x,  uTexel.y));
      vec4 bl = texture2D(uGBuffer, vUv + vec2(-uTexel.x, -uTexel.y));
      vec4 br = texture2D(uGBuffer, vUv + vec2( uTexel.x, -uTexel.y));

      vec3 nc = octDecode(c.xy);

      // --- depth, compared relatively ------------------------------------
      float dc = max(c.z, 0.001);
      float gxD = (tl.z + 2.0 * l.z + bl.z) - (tr.z + 2.0 * r.z + br.z);
      float gyD = (tl.z + 2.0 * u.z + tr.z) - (bl.z + 2.0 * d.z + br.z);
      float depthEdge = sqrt(gxD * gxD + gyD * gyD) / dc;

      // Grazing surfaces have a large depth gradient *by construction* — a road
      // seen from a chase camera changes depth fast across every pixel without
      // there being an edge anywhere. Comparing that against a flat threshold
      // inks the entire road surface, which is what it did: 30% of the frame
      // came back as "edge". Scaling the threshold by how side-on the surface
      // is (the view-space normal's z) makes the test ask the right question:
      // is this depth step bigger than this surface's own slope explains.
      float facing = max(0.12, abs(nc.z));
      float threshold = uDepthThreshold / facing;
      depthEdge = smoothstep(threshold, threshold * 2.5, depthEdge);

      // --- normal ---------------------------------------------------------
      float normalDiff = 0.0;
      normalDiff = max(normalDiff, 1.0 - dot(nc, octDecode(l.xy)));
      normalDiff = max(normalDiff, 1.0 - dot(nc, octDecode(r.xy)));
      normalDiff = max(normalDiff, 1.0 - dot(nc, octDecode(d.xy)));
      normalDiff = max(normalDiff, 1.0 - dot(nc, octDecode(u.xy)));
      float normalEdge = smoothstep(uNormalThreshold, uNormalThreshold * 2.0, normalDiff);

      // --- object id ------------------------------------------------------
      float idEdge = 0.0;
      idEdge = max(idEdge, step(0.01, abs(c.w - l.w)));
      idEdge = max(idEdge, step(0.01, abs(c.w - r.w)));
      idEdge = max(idEdge, step(0.01, abs(c.w - d.w)));
      idEdge = max(idEdge, step(0.01, abs(c.w - u.w)));

      float edge = max(
        max(depthEdge * uDepthStrength, normalEdge * uNormalStrength),
        idEdge * uIdStrength
      );
      // Fade edges out into the far distance along with the fog, so the horizon
      // is not a mat of ink. Faded on the *nearest* depth in the neighbourhood,
      // not the centre: at a scenery-against-sky boundary the centre texel is
      // often the sky, whose depth is the clear value, and fading on that
      // erases exactly the silhouette the fade was never meant to touch.
      float nearDepth = min(min(min(c.z, l.z), min(r.z, d.z)), u.z);
      edge *= 1.0 - smoothstep(90.0, 180.0, nearDepth);
      colour = mix(colour, uInk, clamp(edge, 0.0, 1.0));
    }

    // --- speed streaks ----------------------------------------------------
    vec2 centred = vUv - 0.5;
    float radial = length(centred) * 2.0;
    if (uStreaksEnabled > 0.5 && uSpeedFactor > 0.01) {
      float angle = atan(centred.y, centred.x);
      // Radial stripes, thickened toward the edge. Cheap and reads as motion
      // without touching the simulation at all.
      float stripes = sin(angle * 46.0) * 0.5 + 0.5;
      float mask = smoothstep(0.55, 1.15, radial) * uSpeedFactor;
      colour = mix(colour, colour * 1.55 + vec3(0.10), stripes * mask * 0.42);
    }

    // --- chromatic pinch at the edge during boost --------------------------
    if (uChromatic > 0.001) {
      float amount = uChromatic * 0.006 * smoothstep(0.25, 1.0, radial);
      vec2 dir = normalize(centred + 1e-5);
      float rC = texture2D(uBeauty, vUv - dir * amount).r;
      float bC = texture2D(uBeauty, vUv + dir * amount).b;
      colour = vec3(mix(colour.r, rC, 0.85), colour.g, mix(colour.b, bC, 0.85));
    }

    // Vignette darkens under boost, which reads as tunnel vision.
    float vig = 1.0 - uVignette * smoothstep(0.45, 1.25, radial) * (0.25 + 0.55 * uBoostFactor);
    colour *= vig;

    // Linear → sRGB, here and nowhere else.
    //
    // Every pass upstream works in linear light: the palette's hexes are
    // converted on the way in and the beauty buffer stays linear. Three only
    // applies its own output conversion to materials that include its colour
    // space chunk, and these are hand-written shaders that do not. Without this
    // line the whole game renders linear values into an sRGB display and looks
    // about five stops too dark — which is indistinguishable, on a screenshot,
    // from a palette that has collapsed.
    colour = clamp(colour, 0.0, 1.0);
    vec3 srgb = mix(
      colour * 12.92,
      1.055 * pow(max(colour, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
      step(vec3(0.0031308), colour)
    );

    gl_FragColor = vec4(srgb, 1.0);
  }
`;

export interface EdgeUniformState {
  speedFactor: number;
  boostFactor: number;
  chromatic: number;
  edgesEnabled: boolean;
  streaksEnabled: boolean;
  vignette: number;
}

export class CompositePass {
  readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;

  constructor(theme: Theme) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBeauty: { value: null },
        uGBuffer: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
        uInk: { value: new THREE.Color().setHex(theme.ink, THREE.SRGBColorSpace) },
        uDepthStrength: { value: CONFIG.render.edgeDepthStrength },
        uNormalStrength: { value: CONFIG.render.edgeNormalStrength },
        uIdStrength: { value: CONFIG.render.edgeIdStrength },
        uDepthThreshold: { value: CONFIG.render.edgeDepthThreshold },
        uNormalThreshold: { value: CONFIG.render.edgeNormalThreshold },
        uEdgesEnabled: { value: 1 },
        uSpeedFactor: { value: 0 },
        uBoostFactor: { value: 0 },
        uChromatic: { value: 0 },
        uStreaksEnabled: { value: 1 },
        uVignette: { value: 1 },
      },
    });
    // A single triangle rather than a quad: one fewer vertex, no diagonal seam,
    // and no chance of the two triangles being shaded with different
    // derivatives along the join.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  setInputs(beauty: THREE.Texture, gbuffer: THREE.Texture, gTexel: THREE.Vector2): void {
    this.material.uniforms.uBeauty!.value = beauty;
    this.material.uniforms.uGBuffer!.value = gbuffer;
    (this.material.uniforms.uTexel!.value as THREE.Vector2).copy(gTexel);
  }

  setState(s: EdgeUniformState): void {
    const u = this.material.uniforms;
    u.uSpeedFactor!.value = s.speedFactor;
    u.uBoostFactor!.value = s.boostFactor;
    u.uChromatic!.value = s.chromatic;
    u.uEdgesEnabled!.value = s.edgesEnabled ? 1 : 0;
    u.uStreaksEnabled!.value = s.streaksEnabled ? 1 : 0;
    u.uVignette!.value = s.vignette;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
