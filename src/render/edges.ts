import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { Theme } from '../core/palette.ts';

/**
 * The composite pass: ambient occlusion and a Sobel over the G-buffer, then the
 * screen-space speed effects, then one tone map and one linear→sRGB conversion.
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
 * They are **not** weighted the same. Depth is the silhouette channel and keeps
 * full weight to the far fade; normal and id are interior lines and fade out
 * over a much nearer range, because a drawing that inks a crease as hard as an
 * outline, at any distance, reads as a wireframe rather than as cel work. The
 * ink colour itself drifts toward a darkened fog tint with distance — without
 * that, the tree line on the horizon renders as a row of black cut-outs pasted
 * on the sky.
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
 *
 * The AO reuses the same G-buffer: view-space position is reconstructed from
 * the linear depth and the projection's tangents, so contact darkening costs a
 * handful of extra taps and no extra pass. It is quantised into a few levels
 * for the same reason the light is: soft grey smudge under a kart is a render
 * artefact, three hard steps of contact shadow is a drawing.
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
  uniform vec3 uFogColour;
  uniform float uDepthStrength;
  uniform float uNormalStrength;
  uniform float uIdStrength;
  uniform float uDepthThreshold;
  uniform float uNormalThreshold;
  uniform float uEdgesEnabled;
  uniform vec2 uInteriorFade;   // metres: interior lines gone by .y
  uniform vec2 uInkFade;        // metres over which ink drifts toward fog

  // Ambient occlusion
  uniform vec2 uProj;           // tan(halfFovX), tan(halfFovY)
  uniform float uAoStrength;
  uniform float uAoRadius;
  uniform float uAoLevels;

  // Grade
  uniform float uExposure;
  uniform float uWhitePoint;
  uniform float uSaturation;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;

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

  /** View-space position from a uv and the linear depth stored at it. */
  vec3 viewPosAt(vec2 uv, float depth) {
    return vec3((uv * 2.0 - 1.0) * uProj * depth, -depth);
  }

  float hash12(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  void main() {
    vec3 colour = texture2D(uBeauty, vUv).rgb;
    vec4 c = texture2D(uGBuffer, vUv);
    vec3 nc = octDecode(c.xy);

#ifdef USE_AO
    // --- ambient occlusion, from the G-buffer we already have ---------------
    // Nothing here reaches past the sky's clear depth: the range check kills
    // any sample whose distance is larger than the radius, and the sky's 900 m
    // clear value fails it everywhere.
    if (uAoStrength > 0.0 && c.z < 400.0) {
      vec3 centre = viewPosAt(vUv, c.z);
      // World radius → uv radius at this depth. Without the depth division the
      // AO is a fixed screen ring and a distant kerb gets the same contact
      // shadow as one under the wheels.
      vec2 uvR = vec2(uAoRadius / max(0.5, 2.0 * uProj.x * c.z),
                      uAoRadius / max(0.5, 2.0 * uProj.y * c.z));
      float rot = hash12(gl_FragCoord.xy) * 6.2831853;
      float ca = cos(rot);
      float sa = sin(rot);
      float occ = 0.0;
      for (int i = 0; i < AO_TAPS; i++) {
        float a = (float(i) + 0.5) / float(AO_TAPS) * 6.2831853;
        // Rotated per pixel, and the radius steps outward with the tap index so
        // a small kernel still covers the whole disc instead of one ring.
        vec2 d = vec2(cos(a) * ca - sin(a) * sa, cos(a) * sa + sin(a) * ca);
        float step_ = 0.35 + 0.65 * fract(float(i) * 0.618 + rot);
        vec2 suv = vUv + d * uvR * step_;
        float sd = texture2D(uGBuffer, suv).z;
        vec3 sp = viewPosAt(suv, sd);
        vec3 diff = sp - centre;
        float len = length(diff);
        if (len > 0.001) {
          // Bias of 0.06: without it the surface occludes itself wherever the
          // reconstructed neighbour lands a hair in front, and every flat road
          // comes back uniformly grey.
          float v = max(0.0, dot(diff / len, nc) - 0.06);
          occ += v * (1.0 - smoothstep(uAoRadius * 0.7, uAoRadius * 1.6, len));
        }
      }
      occ = clamp(occ / float(AO_TAPS) * 2.2, 0.0, 1.0);
      // Quantised: contact shading is drawn, not rendered.
      occ = floor(occ * uAoLevels) / max(1.0, uAoLevels - 1.0);
      colour *= 1.0 - clamp(occ, 0.0, 1.0) * uAoStrength;
    }
#endif

    if (uEdgesEnabled > 0.5) {
      // 3x3 neighbourhood, spaced one G-buffer texel apart.
      vec4 l  = texture2D(uGBuffer, vUv + vec2(-uTexel.x, 0.0));
      vec4 r  = texture2D(uGBuffer, vUv + vec2( uTexel.x, 0.0));
      vec4 d  = texture2D(uGBuffer, vUv + vec2(0.0, -uTexel.y));
      vec4 u  = texture2D(uGBuffer, vUv + vec2(0.0,  uTexel.y));
      vec4 tl = texture2D(uGBuffer, vUv + vec2(-uTexel.x,  uTexel.y));
      vec4 tr = texture2D(uGBuffer, vUv + vec2( uTexel.x,  uTexel.y));
      vec4 bl = texture2D(uGBuffer, vUv + vec2(-uTexel.x, -uTexel.y));
      vec4 br = texture2D(uGBuffer, vUv + vec2( uTexel.x, -uTexel.y));

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

      // Faded on the *nearest* depth in the neighbourhood, not the centre: at a
      // scenery-against-sky boundary the centre texel is often the sky, whose
      // depth is the clear value, and fading on that erases exactly the
      // silhouette the fade was never meant to touch.
      float nearDepth = min(min(min(c.z, l.z), min(r.z, d.z)), u.z);

      // Line weight by importance. Interior lines go first and go early; the
      // silhouette survives to the far fade.
      float interior = 1.0 - smoothstep(uInteriorFade.x, uInteriorFade.y, nearDepth);
      float edge = max(
        depthEdge * uDepthStrength,
        max(normalEdge * uNormalStrength, idEdge * uIdStrength) * interior
      );
      // Fade edges out into the far distance along with the fog, so the horizon
      // is not a mat of ink.
      edge *= 1.0 - smoothstep(90.0, 180.0, nearDepth);

      // Distant ink is atmospheric, not black. 0.55 of the fog colour keeps it
      // clearly a line while letting it belong to the air it is drawn in.
      vec3 ink = mix(uInk, uFogColour * 0.55, smoothstep(uInkFade.x, uInkFade.y, nearDepth));
      colour = mix(colour, ink, clamp(edge, 0.0, 1.0));
    }

    // --- speed streaks ----------------------------------------------------
    vec2 centred = vUv - 0.5;
    float radial = length(centred) * 2.0;
    if (uStreaksEnabled > 0.5 && uSpeedFactor > 0.01) {
      float angle = atan(centred.y, centred.x);
      // Streaks of varied length and width rather than one even starburst: the
      // even version reads as a lens filter, this reads as motion. The hash is
      // on the *angle cell*, so each streak keeps its identity as speed rises
      // instead of the whole fan shimmering.
      float cell = floor(angle * 7.6);
      float rnd = hash12(vec2(cell, 3.0));
      float width = mix(6.0, 22.0, rnd);
      float stripes = pow(sin(angle * width) * 0.5 + 0.5, 2.2);
      float reach = mix(0.78, 0.40, rnd);
      float mask = smoothstep(reach, reach + 0.55, radial) * uSpeedFactor;
      colour = mix(colour, colour * 1.7 + vec3(0.09), stripes * mask * (0.34 + 0.30 * uBoostFactor));
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

    // --- tone map and grade ------------------------------------------------
    // A Reinhard shoulder with a white point rather than an ACES fit: ACES
    // crushes the darkest cel band down into the ink colour and the bands are
    // the whole look. This keeps the shadow end nearly linear and only bends
    // the top, which is where the sun-lit bands were flattening out.
    colour = max(colour, vec3(0.0)) * uExposure;
    colour = colour * (1.0 + colour / (uWhitePoint * uWhitePoint)) / (1.0 + colour);
    float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    colour = mix(vec3(luma), colour, uSaturation);
    // Split tone. Deliberately gentle: push it further and the ink stops
    // matching the theme's ink colour, which is what analyseEdges() keys off,
    // so the line-system proof starts failing for a grading reason.
    colour *= mix(uShadowTint, uHighlightTint, smoothstep(0.10, 0.80, luma));

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

export interface CompositeOptions {
  /** Tap count for the G-buffer AO, or 0 to compile it out entirely. A
   *  **structural** decision from the quality tier, resolved once at load —
   *  a `#define`, not a uniform, so the loop does not exist on a device that
   *  cannot afford it (ARCHITECTURE.md §8). */
  aoTaps: number;
}

export class CompositePass {
  readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;

  constructor(theme: Theme, opts: CompositeOptions = { aoTaps: 8 }) {
    const R = CONFIG.render;
    this.material = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      defines: opts.aoTaps > 0 ? { USE_AO: '', AO_TAPS: String(opts.aoTaps) } : {},
      uniforms: {
        uBeauty: { value: null },
        uGBuffer: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
        uInk: { value: new THREE.Color().setHex(theme.ink, THREE.SRGBColorSpace) },
        uFogColour: { value: new THREE.Color().setHex(theme.fog, THREE.SRGBColorSpace) },
        uDepthStrength: { value: R.edgeDepthStrength },
        uNormalStrength: { value: R.edgeNormalStrength },
        uIdStrength: { value: R.edgeIdStrength },
        uDepthThreshold: { value: R.edgeDepthThreshold },
        uNormalThreshold: { value: R.edgeNormalThreshold },
        uEdgesEnabled: { value: 1 },
        uInteriorFade: { value: new THREE.Vector2(R.edgeInteriorNear, R.edgeInteriorFar) },
        uInkFade: { value: new THREE.Vector2(R.edgeInkFadeNear, R.edgeInkFadeFar) },
        uProj: { value: new THREE.Vector2(1, 1) },
        uAoStrength: { value: opts.aoTaps > 0 ? R.aoStrength : 0 },
        uAoRadius: { value: R.aoRadius },
        uAoLevels: { value: R.aoLevels },
        uExposure: { value: R.exposure },
        uWhitePoint: { value: R.whitePoint },
        uSaturation: { value: R.saturation },
        uShadowTint: { value: new THREE.Vector3(...R.shadowTint) },
        uHighlightTint: { value: new THREE.Vector3(...R.highlightTint) },
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

  /**
   * The projection tangents the AO reconstructs view positions with. Updated
   * every frame rather than on resize because the chase camera's FOV moves with
   * speed — a stale tangent makes the AO radius breathe with the boost.
   */
  setCamera(camera: THREE.PerspectiveCamera): void {
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    (this.material.uniforms.uProj!.value as THREE.Vector2).set(tanY * camera.aspect, tanY);
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
