import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import type { Theme } from '../core/palette.ts';

/**
 * Cel shading through a quantised, nearest-filtered ramp.
 *
 * Flat bands, hard steps, no gradients. The ramp is a real texture rather than
 * a `floor()` in the shader for one reason: NearestFilter is what guarantees
 * the steps stay hard. With LinearFilter the GPU interpolates between texels
 * and every "hard step" becomes a soft gradient — which is the whole look,
 * gone, for a one-word difference.
 *
 * Bug class 7 lives here too: Three.js defines `USE_INSTANCING` for any
 * `InstancedMesh`, but a hand-written vertex shader must apply `instanceMatrix`
 * itself. Forget it and the entire instance set draws stacked on the origin —
 * and it passes a count assertion, because the instances all exist.
 */

/** Object id channel written into the G-buffer. Ids only need to *differ*
 *  between things that can touch on screen; the Sobel compares them for
 *  inequality, never for order. */
export const OBJECT_IDS = {
  track: 0.1,
  /** The terrain shell outside the barriers. Distinct from `track` so the id
   *  channel draws the line where the embankment meets the verge — the two are
   *  coplanar at the seam, so neither depth nor normal finds it. */
  terrain: 0.15,
  wall: 0.2,
  kart: 0.35,
  wheel: 0.45,
  driver: 0.55,
  item: 0.7,
  scenery: 0.85,
  sky: 0.0,
} as const;

/** Meshes on this layer are outline hulls: rendered into the beauty pass but
 *  **excluded from the G-buffer**, or every silhouette gets drawn twice — once
 *  by the hull and once by the Sobel — and the doubled line reads as a smear. */
export const LAYER_OUTLINE = 1;

/**
 * The same layer, named for its other use. Anything that must be drawn into the
 * beauty pass but must **not** write the G-buffer belongs here: particles and
 * blended effects have no surface for a crease to sit on, and letting them
 * write a normal and a depth inks a hard outline around every spark.
 */
export const LAYER_BEAUTY_ONLY = LAYER_OUTLINE;

let rampTexture: THREE.DataTexture | null = null;

/**
 * Ramp rows: **per-material band counts**, in one texture.
 *
 * A kart and a hillside do not want the same number of steps. Karts are the
 * hero objects and are read close up, so they get one band more than standard
 * and a slightly darker shadow side — crisper, more sculpted. Terrain fills
 * half the frame and gets one band fewer with a brighter terminator, so a
 * hillside does not turn into three hard stripes of colour.
 *
 * One texture with three rows rather than three textures: the row is a uniform,
 * so every material still shares one texture unit and one upload.
 */
export const RAMP_ROWS = { soft: 0, standard: 1, crisp: 2 } as const;
export type RampKind = keyof typeof RAMP_ROWS;
const RAMP_ROW_COUNT = 3;

/** v coordinate that lands in the middle of a row's texel. */
export function rampV(kind: RampKind): number {
  return (RAMP_ROWS[kind] + 0.5) / RAMP_ROW_COUNT;
}

/**
 * The shared quantised ramp. Width 64 so the band edges land on predictable
 * texel boundaries; the *values* only ever take `bands` distinct levels per row.
 */
export function celRamp(): THREE.DataTexture {
  if (rampTexture) return rampTexture;
  const width = 64;
  const base = CONFIG.render.celBands;
  // [bands, gamma]. The gamma shifts where the terminator lands: >1 pushes it
  // toward the light and deepens the shadow side (crisp), <1 pulls it back and
  // lifts the shadow side (soft).
  const rows: [number, number][] = [
    [Math.max(2, base - 1), 0.82],
    [base, 1.0],
    [base + 1, 1.18],
  ];
  const data = new Uint8Array(width * RAMP_ROW_COUNT * 4);
  for (let r = 0; r < RAMP_ROW_COUNT; r++) {
    const [bands, gamma] = rows[r]!;
    for (let i = 0; i < width; i++) {
      const t = Math.pow(i / (width - 1), gamma);
      // Quantise, then bias the lowest band up slightly: a pure 0 band
      // multiplies the base colour to black and takes the surface with it
      // (bug class 8).
      const band = Math.floor(t * bands) / (bands - 1);
      const v = Math.min(1, band);
      const b = Math.round(v * 255);
      const o = (r * width + i) * 4;
      data[o + 0] = b;
      data[o + 1] = b;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, RAMP_ROW_COUNT, THREE.RGBAFormat);
  // The whole point. LinearFilter here turns every hard step into a gradient —
  // and on a multi-row ramp it would also bleed one row's band count into the
  // next, so a kart would be lit by an average of three ramps.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  rampTexture = tex;
  return tex;
}

export interface CelOptions {
  /** Base colour, ignored when `vertexColours` is set. */
  colour?: number;
  vertexColours?: boolean;
  objectId?: number;
  /** Adds a hard specular band. Used on karts and chrome, not on the road. */
  gloss?: number;
  /** Rim light strength. Cheap separation from the background on dark themes. */
  rim?: number;
  /**
   * Floor under the theme's own ambient level, for hero objects.
   *
   * Symptom this fixes: on the bright themes — the salt flat especially — a
   * kart's saturated mid-tone body sat at about a seventh of the ground's
   * value. That is physically right and it reads as a black blob: all the
   * internal banding crushes together and the kart stops being a shape. Hero
   * objects get a higher floor than the world they sit on so their own bands
   * stay separated, which is what keeps them readable as karts rather than as
   * silhouettes.
   */
  minAmbient?: number;
  /** Which band count this surface is lit with. Defaults to `standard`. */
  ramp?: RampKind;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

const CEL_VERTEX = /* glsl */ `
  attribute float aObjId;
  varying vec3 vNormalW;
  varying vec3 vViewPos;
  varying vec3 vColour;
  varying float vObjId;

  void main() {
    #ifdef USE_COLOR
      vColour = color;
    #else
      vColour = vec3(1.0);
    #endif
    vObjId = aObjId;

    vec3 transformed = position;
    vec3 objectNormal = normal;

    mat4 modelMat = modelMatrix;
    #ifdef USE_INSTANCING
      // Bug class 7. Without these two lines every instance draws at the
      // origin, in one invisible pile, and a count assertion still passes.
      modelMat = modelMatrix * instanceMatrix;
      objectNormal = mat3(instanceMatrix) * objectNormal;
    #endif

    vec4 worldPos = modelMat * vec4(transformed, 1.0);
    vNormalW = normalize(mat3(modelMat) * objectNormal);
    vec4 viewPos = viewMatrix * worldPos;
    vViewPos = viewPos.xyz;
    gl_Position = projectionMatrix * viewPos;
  }
`;

const CEL_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3 uBaseColour;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform vec3 uAmbientColour;
  uniform vec3 uSkyColour;
  uniform vec3 uBounceColour;
  uniform float uAmbientLevel;
  uniform float uRampV;
  uniform sampler2D uRamp;
  uniform vec3 uFogColour;
  uniform float uFogDensity;
  uniform float uGloss;
  uniform float uRim;
  uniform float uOpacity;

  varying vec3 vNormalW;
  varying vec3 vViewPos;
  varying vec3 vColour;

  /** A colour reduced to a pure hue shift: unit luminance, no brightness. */
  vec3 unitLuma(vec3 c) {
    return c / max(0.001, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  }

  void main() {
    vec3 n = normalize(vNormalW);
    // Two-sided: the tunnel roof and the underside of ramps are seen from
    // behind, and a black interior is not a shading choice, it is a hole.
    if (!gl_FrontFacing) n = -n;

    float ndl = dot(n, uSunDir) * 0.5 + 0.5;
    float band = texture2D(uRamp, vec2(clamp(ndl, 0.0, 1.0), uRampV)).r;

    vec3 base = uBaseColour * vColour;

    // --- fill light -------------------------------------------------------
    // One sun and one flat ambient floor gives every surface facing away from
    // the light exactly one value, and the form disappears — the shadow side of
    // a kart came out as a single silhouette-shaped patch of paint. This is a
    // deliberately weak second light from the opposite quarter of the sky,
    // quantised to two steps so it stays cel rather than becoming a gradient.
    vec3 fillDir = normalize(vec3(-uSunDir.x, 0.42, -uSunDir.z));
    float ndf = dot(n, fillDir);
    float fill = step(0.05, ndf) * 0.5 + step(0.55, ndf) * 0.5;

    // --- hemisphere bounce ------------------------------------------------
    // The ambient term is no longer a constant: sky above, warm ground bounce
    // below, one step between. Three discrete levels, so an upward face, a
    // vertical face and an underside are three different values even where the
    // sun reaches none of them. This is what makes the world read as sculpted
    // instead of as flat paper.
    float upness = clamp(n.y * 0.5 + 0.5, 0.0, 0.999);
    float hq = floor(upness * 3.0) / 2.0;
    vec3 hemiTint = unitLuma(mix(uBounceColour, uSkyColour, hq));
    // 0.70..1.26 around the theme's ambient level. The low end is bounded by
    // bug class 8: at 0.70 the darkest theme's underside still sits above the
    // shaded-luminance floor that keeps a surface separate from the ink.
    float hemiLevel = mix(0.70, 1.26, hq);
    float ambient = uAmbientLevel * hemiLevel * (0.84 + 0.28 * fill);

    // The light's colour is a *hue* shift, not an intensity. Multiplying by it
    // raw darkens everything by its own luminance as well — this theme's
    // ambient has a linear luminance of 0.19, so the whole world rendered five
    // times too dark and every surface collapsed to black. Normalising the tint
    // to unit luminance leaves the band term as the only thing controlling
    // brightness, which is what makes the bands mean anything.
    vec3 shadeTint = mix(unitLuma(uAmbientColour), hemiTint, 0.6);
    vec3 tint = mix(shadeTint, unitLuma(uSunColour), band);
    // Applied at 45% strength: full-strength tinting makes shadowed surfaces
    // read as blue paint rather than as the same paint in shadow.
    tint = mix(vec3(1.0), tint, 0.45);

    vec3 lit = base * tint * (ambient + (1.0 - uAmbientLevel) * band);

    // A single hard specular band, not a falloff — a smooth highlight on a cel
    // surface reads as a rendering mistake rather than as shine.
    if (uGloss > 0.0) {
      vec3 viewDir = normalize(-vViewPos);
      vec3 viewNormal = normalize(mat3(viewMatrix) * n);
      vec3 halfDir = normalize(normalize(mat3(viewMatrix) * uSunDir) + viewDir);
      float spec = dot(viewNormal, halfDir);
      lit += unitLuma(uSunColour) * uGloss * step(0.945, spec);
    }

    // Rim / backlight. Not a plain fresnel ring: it is weighted by how much the
    // surface faces *away* from the sun, so it behaves like sky wrapping round a
    // backlit object. That is what separates a kart from the road behind it
    // without an outline having to do all the work.
    if (uRim > 0.0) {
      vec3 viewDir = normalize(-vViewPos);
      vec3 viewNormal = normalize(mat3(viewMatrix) * n);
      float fres = 1.0 - max(0.0, dot(viewNormal, viewDir));
      float back = smoothstep(-0.35, 0.45, dot(n, -uSunDir));
      lit += unitLuma(uSkyColour) * uRim * step(0.58, fres) * (0.30 + 0.85 * back);
    }

    // Exponential-squared fog on view depth. Applied here rather than as a post
    // pass so it lands *before* the edge detect and distant edges fade with the
    // geometry they belong to.
    float dist = length(vViewPos);
    float f = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
    vec3 outColour = mix(lit, uFogColour, clamp(f, 0.0, 1.0));

    gl_FragColor = vec4(outColour, uOpacity);
  }
`;

export function makeCelMaterial(theme: Theme, opts: CelOptions = {}): THREE.ShaderMaterial {
  const sunDir = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: CEL_VERTEX,
    fragmentShader: CEL_FRAGMENT,
    vertexColors: !!opts.vertexColours,
    transparent: !!opts.transparent,
    side: opts.side ?? THREE.FrontSide,
    uniforms: {
      uBaseColour: {
        value: new THREE.Color().setHex(opts.colour ?? 0xffffff, THREE.SRGBColorSpace),
      },
      uSunDir: { value: sunDir },
      uSunColour: { value: new THREE.Color().setHex(theme.sun, THREE.SRGBColorSpace) },
      uAmbientColour: { value: new THREE.Color().setHex(theme.ambient, THREE.SRGBColorSpace) },
      // Sky above and warm ground bounce below, for the hemisphere fill. The
      // theme's own sand is the bounce because it is the warmest terrain colour
      // every theme is required to define, so no theme needs a new field.
      uSkyColour: { value: new THREE.Color().setHex(theme.skyTop, THREE.SRGBColorSpace) },
      uBounceColour: { value: new THREE.Color().setHex(theme.sand, THREE.SRGBColorSpace) },
      uAmbientLevel: { value: Math.max(theme.ambientLevel, opts.minAmbient ?? 0) },
      uRampV: { value: rampV(opts.ramp ?? 'standard') },
      uRamp: { value: celRamp() },
      uFogColour: { value: new THREE.Color().setHex(theme.fog, THREE.SRGBColorSpace) },
      uFogDensity: { value: theme.fogDensity },
      uGloss: { value: opts.gloss ?? 0 },
      uRim: { value: opts.rim ?? 0 },
      uOpacity: { value: opts.opacity ?? 1 },
    },
  });
  return mat;
}

/** Point every cel material at the sun. Called once per track load, not per
 *  frame — the sun does not move. */
export function setSunDirection(materials: THREE.ShaderMaterial[], dir: THREE.Vector3): void {
  for (const m of materials) {
    const u = m.uniforms.uSunDir;
    if (u) (u.value as THREE.Vector3).copy(dir);
  }
}

/**
 * Tag a geometry with an object id for the G-buffer.
 *
 * As a vertex attribute rather than a uniform because `scene.overrideMaterial`
 * shares one material across every draw call, and a uniform set per object is
 * not reliably re-uploaded between them. An attribute is per-vertex data and
 * cannot be skipped.
 */
export function tagGeometry(geometry: THREE.BufferGeometry, id: number): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const arr = new Float32Array(count);
  arr.fill(id);
  geometry.setAttribute('aObjId', new THREE.BufferAttribute(arr, 1));
  return geometry;
}

/**
 * Per-position averaged normals, stored as `aSmoothNormal`.
 *
 * The inverted-hull outline needs these: expanding a hard-edged mesh along its
 * face normals splits the hull open at every crease, and the silhouette gets
 * visible gaps at exactly the corners you most wanted a line on. The render
 * normals stay hard so the cel bands stay hard — these are a second attribute,
 * not a replacement.
 */
export function computeSmoothNormals(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const count = pos.count;
  const map = new Map<string, [number, number, number]>();
  const key = (i: number) =>
    `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;

  for (let i = 0; i < count; i++) {
    const k = key(i);
    const acc = map.get(k);
    if (acc) {
      acc[0] += nor.getX(i);
      acc[1] += nor.getY(i);
      acc[2] += nor.getZ(i);
    } else {
      map.set(k, [nor.getX(i), nor.getY(i), nor.getZ(i)]);
    }
  }

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const acc = map.get(key(i))!;
    const l = Math.hypot(acc[0], acc[1], acc[2]) || 1;
    out[i * 3 + 0] = acc[0] / l;
    out[i * 3 + 1] = acc[1] / l;
    out[i * 3 + 2] = acc[2] / l;
  }
  geometry.setAttribute('aSmoothNormal', new THREE.BufferAttribute(out, 3));
  return geometry;
}
