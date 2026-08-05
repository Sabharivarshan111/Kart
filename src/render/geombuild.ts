import * as THREE from 'three';

/**
 * A tiny flat-shaded geometry builder.
 *
 * Everything in the game is generated in code — the brief's hard rule is zero
 * external assets — so this is the primitive layer everything else is made of.
 * Every face gets its own vertices and its own face normal: smooth normals
 * would let the cel ramp interpolate across an edge, and a soft band boundary
 * is precisely the thing the look is defined by not having.
 */

const tmpColour = new THREE.Color();

export class MeshBuilder {
  private pos: number[] = [];
  private norm: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  /** Transform applied to everything added until it is changed. */
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();

  setTransform(matrix: THREE.Matrix4): this {
    this.m.copy(matrix);
    this.nm.getNormalMatrix(this.m);
    return this;
  }

  resetTransform(): this {
    this.m.identity();
    this.nm.identity();
    return this;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, hex: number): number {
    const i = this.pos.length / 3;
    this.v.set(x, y, z).applyMatrix4(this.m);
    this.pos.push(this.v.x, this.v.y, this.v.z);
    this.v.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.norm.push(this.v.x, this.v.y, this.v.z);
    // Authored in sRGB, rendered in linear: without the conversion every
    // surface reads about 40% too bright and the cel bands land wrong.
    tmpColour.setHex(hex, THREE.SRGBColorSpace);
    this.col.push(tmpColour.r, tmpColour.g, tmpColour.b);
    return i;
  }

  /**
   * Quad from four corners, with a computed face normal.
   *
   * The corners are given in the order that reads naturally when facing the
   * surface from outside; both the normal and the triangle winding are then
   * flipped so the face ends up front-facing under GL's counter-clockwise
   * convention.
   *
   * Symptom this fixes: without the flip every box in the game was inside-out.
   * The outward faces were all back-facing and culled, so what reached the
   * screen was the *inside* of the far side of each box, shaded by a normal
   * pointing at the camera. Scenery looked plausible by luck; the karts came
   * out as solid black shells with a few coloured lines where the sidepod rails
   * showed through.
   */
  quad(
    a: THREE.Vector3Like,
    b: THREE.Vector3Like,
    c: THREE.Vector3Like,
    d: THREE.Vector3Like,
    hex: number,
  ): void {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
    let nx = -(uy * wz - uz * wy);
    let ny = -(uz * wx - ux * wz);
    let nz = -(ux * wy - uy * wx);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.vertex(a.x, a.y, a.z, nx, ny, nz, hex);
    const i1 = this.vertex(b.x, b.y, b.z, nx, ny, nz, hex);
    const i2 = this.vertex(c.x, c.y, c.z, nx, ny, nz, hex);
    const i3 = this.vertex(d.x, d.y, d.z, nx, ny, nz, hex);
    this.idx.push(i0, i2, i1, i0, i3, i2);
  }

  triangle(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, hex: number): void {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
    let nx = -(uy * wz - uz * wy);
    let ny = -(uz * wx - ux * wz);
    let nz = -(ux * wy - uy * wx);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.vertex(a.x, a.y, a.z, nx, ny, nz, hex);
    const i1 = this.vertex(b.x, b.y, b.z, nx, ny, nz, hex);
    const i2 = this.vertex(c.x, c.y, c.z, nx, ny, nz, hex);
    this.idx.push(i0, i2, i1);
  }

  /**
   * A box, optionally tapered: `taper` scales the +Y face in X and Z. A tapered
   * box is the single most useful shape here — a kart nose, a spoiler stay, a
   * building, a tree trunk and a helmet are all tapered boxes.
   */
  box(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    hex: number,
    taperX = 1,
    taperZ = 1,
  ): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const tx = hx * taperX, tz = hz * taperZ;
    const p = (x: number, y: number, z: number) => ({ x: cx + x, y: cy + y, z: cz + z });

    const b0 = p(-hx, -hy, -hz), b1 = p(hx, -hy, -hz), b2 = p(hx, -hy, hz), b3 = p(-hx, -hy, hz);
    const t0 = p(-tx, hy, -tz), t1 = p(tx, hy, -tz), t2 = p(tx, hy, tz), t3 = p(-tx, hy, tz);

    this.quad(t0, t1, t2, t3, hex);      // top
    this.quad(b3, b2, b1, b0, hex);      // bottom
    this.quad(b0, b1, t1, t0, hex);      // -Z
    this.quad(b2, b3, t3, t2, hex);      // +Z
    this.quad(b1, b2, t2, t1, hex);      // +X
    this.quad(b3, b0, t0, t3, hex);      // -X
  }

  /** A prism along Y with `sides` faces. Wheels, poles, drums, wheel rims. */
  cylinder(
    cx: number, cy: number, cz: number,
    radius: number,
    height: number,
    sides: number,
    hex: number,
    capHex = hex,
  ): void {
    const hy = height / 2;
    const ring: { x: number; z: number }[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      ring.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius });
    }
    for (let i = 0; i < sides; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % sides]!;
      this.quad(
        { x: cx + a.x, y: cy - hy, z: cz + a.z },
        { x: cx + b.x, y: cy - hy, z: cz + b.z },
        { x: cx + b.x, y: cy + hy, z: cz + b.z },
        { x: cx + a.x, y: cy + hy, z: cz + a.z },
        hex,
      );
    }
    for (let i = 1; i < sides - 1; i++) {
      const a = ring[0]!, b = ring[i]!, c = ring[i + 1]!;
      this.triangle(
        { x: cx + a.x, y: cy + hy, z: cz + a.z },
        { x: cx + b.x, y: cy + hy, z: cz + b.z },
        { x: cx + c.x, y: cy + hy, z: cz + c.z },
        capHex,
      );
      this.triangle(
        { x: cx + c.x, y: cy - hy, z: cz + c.z },
        { x: cx + b.x, y: cy - hy, z: cz + b.z },
        { x: cx + a.x, y: cy - hy, z: cz + a.z },
        capHex,
      );
    }
  }

  /** A wedge: a box whose +Z face is pulled down to a chosen height. Noses,
   *  ramps, spoiler blades. */
  wedge(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    frontHeight: number,
    hex: number,
  ): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const fy = -hy + frontHeight;
    const p = (x: number, y: number, z: number) => ({ x: cx + x, y: cy + y, z: cz + z });
    const b0 = p(-hx, -hy, -hz), b1 = p(hx, -hy, -hz), b2 = p(hx, -hy, hz), b3 = p(-hx, -hy, hz);
    const t0 = p(-hx, hy, -hz), t1 = p(hx, hy, -hz);
    const f2 = p(hx, fy, hz), f3 = p(-hx, fy, hz);
    this.quad(t0, t1, f2, f3, hex);   // sloped top
    this.quad(b3, b2, b1, b0, hex);   // bottom
    this.quad(b0, b1, t1, t0, hex);   // back
    this.quad(b2, b3, f3, f2, hex);   // front
    this.triangle(b1, b2, f2, hex);
    this.triangle(b1, f2, t1, hex);
    this.triangle(b3, b0, t0, hex);
    this.triangle(b3, t0, f3, hex);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
