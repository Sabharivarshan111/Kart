import * as THREE from 'three';

/**
 * The G-buffer: view normal (octahedral, 2 channels), linear depth, object id.
 *
 * It exists for the interior lines a hull trick cannot draw. An inverted hull
 * only ever produces a silhouette; it has nothing to say about the crease
 * between a kart's nose and its bonnet, or about two objects meeting at the
 * same depth and the same angle. Those need a Sobel over something that knows
 * about surfaces, which is this.
 *
 * Rendered with `scene.overrideMaterial`, with the outline layer disabled on
 * the camera — hulls must not appear here or every silhouette is drawn twice.
 */

const GBUFFER_VERTEX = /* glsl */ `
  attribute float aObjId;
  varying vec3 vViewNormal;
  varying float vViewDepth;
  varying float vObjId;

  void main() {
    mat4 modelMat = modelMatrix;
    vec3 objectNormal = normal;
    #ifdef USE_INSTANCING
      // Same trap as the cel shader: without this the whole instance set piles
      // up at the origin and writes a G-buffer full of nothing.
      modelMat = modelMatrix * instanceMatrix;
      objectNormal = mat3(instanceMatrix) * objectNormal;
    #endif

    vObjId = aObjId;
    vec4 viewPos = viewMatrix * modelMat * vec4(position, 1.0);
    vViewNormal = normalize(mat3(viewMatrix) * normalize(mat3(modelMat) * objectNormal));
    vViewDepth = -viewPos.z;
    gl_Position = projectionMatrix * viewPos;
  }
`;

const GBUFFER_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec3 vViewNormal;
  varying float vViewDepth;
  varying float vObjId;

  // Octahedral normal encoding. Storing only normal.xy would be a channel
  // cheaper, but two surfaces differing only in the sign of z would then encode
  // identically and their shared crease would never produce a line.
  vec2 octEncode(vec3 n) {
    n /= (abs(n.x) + abs(n.y) + abs(n.z));
    vec2 o = n.xy;
    if (n.z < 0.0) o = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    return o * 0.5 + 0.5;
  }

  void main() {
    vec3 n = normalize(vViewNormal);
    if (!gl_FrontFacing) n = -n;
    // Linear depth in metres, straight into a half-float channel. Not the
    // non-linear gl_FragCoord.z: the Sobel compares depth *relatively*, and a
    // relative comparison on a hyperbolic value is meaningless.
    gl_FragColor = vec4(octEncode(n), vViewDepth, vObjId);
  }
`;

export class GBuffer {
  readonly target: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  /** Resolution scale relative to the beauty buffer. Half res is the cheapest
   *  large saving available on mobile — but see `edges.ts`: the Sobel taps then
   *  have to be spaced in *G-buffer* texels, not screen pixels. */
  private scale: number;

  constructor(width: number, height: number, scale = 0.5) {
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
      {
        // Half float: depth is stored in metres and would clip at 1.0 in an
        // 8-bit target, making every surface past a metre identical.
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      },
    );
    this.material = new THREE.ShaderMaterial({
      vertexShader: GBUFFER_VERTEX,
      fragmentShader: GBUFFER_FRAGMENT,
      side: THREE.FrontSide,
      uniforms: {},
    });
  }

  setSize(width: number, height: number, scale = this.scale): void {
    this.scale = scale;
    this.target.setSize(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
  }

  get texelSize(): THREE.Vector2 {
    return new THREE.Vector2(1 / this.target.width, 1 / this.target.height);
  }

  get size(): { width: number; height: number; scale: number } {
    return { width: this.target.width, height: this.target.height, scale: this.scale };
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
