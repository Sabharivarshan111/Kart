import * as THREE from 'three';
import { KART_COLOURS } from '../core/palette.ts';
import type { ItemSystem } from '../race/items.ts';
import type { Kart } from '../vehicle/kart.ts';
import { OBJECT_IDS, tagGeometry } from './celmaterial.ts';
import { MeshBuilder } from './geombuild.ts';
import type { World } from './world.ts';

/**
 * Visuals for item boxes, projectiles, traps and orbiting shields.
 *
 * Everything is pooled and preallocated. The pools are sized from the item
 * system's own limits, so a frame never allocates a mesh — and an item that
 * despawns leaves its mesh parked below the road rather than at the origin,
 * where it would draw a permanent pile in the middle of the track.
 */

const PARKED_Y = -1000;

export class ItemView {
  private readonly boxMesh: THREE.InstancedMesh;
  private readonly boxHull: THREE.InstancedMesh;
  private readonly entityMeshes: THREE.Mesh[] = [];
  private readonly shieldMeshes: THREE.Mesh[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3(0.3, 1, 0.2).normalize();
  private readonly scratch = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly items: ItemSystem,
    world: World,
    kartCount: number,
  ) {
    // --- item boxes ---------------------------------------------------------
    const bb = new MeshBuilder();
    bb.box(0, 0, 0, 1.1, 1.1, 1.1, KART_COLOURS.amber!, 0.62, 0.62);
    const boxGeo = tagGeometry(bb.build(), OBJECT_IDS.item);
    const boxMat = world.celMaterial({ vertexColours: true, gloss: 0.3, rim: 0.22 });
    this.boxMesh = new THREE.InstancedMesh(boxGeo, boxMat, Math.max(1, items.boxes.length));
    this.boxMesh.frustumCulled = false;
    world.add(this.boxMesh);
    this.boxHull = world.outlines.attachInstanced(this.boxMesh);
    world.add(this.boxHull);

    // --- projectiles and traps ---------------------------------------------
    const pb = new MeshBuilder();
    pb.box(0, 0, 0, 0.62, 0.44, 0.86, KART_COLOURS.teal!, 0.4, 0.3);
    const projGeo = tagGeometry(pb.build(), OBJECT_IDS.item);
    const projMat = world.celMaterial({ vertexColours: true, gloss: 0.36, rim: 0.3 });
    for (const e of items.entities) {
      void e;
      const mesh = new THREE.Mesh(projGeo, projMat);
      mesh.position.y = PARKED_Y;
      mesh.frustumCulled = false;
      world.outlines.attach(mesh);
      world.add(mesh);
      this.entityMeshes.push(mesh);
    }

    // --- shields ------------------------------------------------------------
    const sb = new MeshBuilder();
    sb.cylinder(0, 0, 0, 0.42, 0.34, 6, KART_COLOURS.violet!);
    const shieldGeo = tagGeometry(sb.build(), OBJECT_IDS.item);
    const shieldMat = world.celMaterial({
      vertexColours: true,
      transparent: true,
      opacity: 0.85,
      rim: 0.4,
    });
    for (let i = 0; i < kartCount; i++) {
      const mesh = new THREE.Mesh(shieldGeo, shieldMat);
      mesh.position.y = PARKED_Y;
      mesh.frustumCulled = false;
      world.add(mesh);
      this.shieldMeshes.push(mesh);
    }
  }

  update(time: number, karts: Kart[]): void {
    // Boxes spin and bob; a cooling-down box shrinks to nothing rather than
    // vanishing, so the player can see it is coming back.
    for (let i = 0; i < this.items.boxes.length; i++) {
      const box = this.items.boxes[i]!;
      const ready = box.cooldown <= 0;
      const s = ready ? 1 : Math.max(0, 1 - box.cooldown / 4) * 0.8;
      this.pos.set(box.x, box.y + Math.sin(time * 2 + i) * 0.12, box.z);
      this.quat.setFromAxisAngle(this.axis, time * 1.6 + i);
      this.scale.setScalar(Math.max(0.001, s));
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.boxMesh.setMatrixAt(i, this.matrix);
    }
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.boxHull.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.entityMeshes.length; i++) {
      const e = this.items.entities[i]!;
      const mesh = this.entityMeshes[i]!;
      if (!e.alive) {
        mesh.position.y = PARKED_Y;
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(e.x, e.y, e.z);
      if (e.kind === 'grease') {
        // A slick is a flat spreading patch, not an object.
        mesh.scale.set(4.6, 0.06, 4.6);
        mesh.rotation.set(0, 0, 0);
      } else if (e.kind === 'burr') {
        mesh.scale.setScalar(0.9);
        mesh.rotation.y = time * 3;
      } else {
        mesh.scale.setScalar(1);
        mesh.rotation.y = Math.atan2(e.vx, e.vz);
        mesh.rotation.x = time * 9;
      }
    }

    for (let i = 0; i < this.shieldMeshes.length; i++) {
      const mesh = this.shieldMeshes[i]!;
      if (this.items.shields[i]! <= 0 || !karts[i]) {
        mesh.position.y = PARKED_Y;
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      this.items.shieldPosition(i, karts[i]!, this.scratch);
      mesh.position.set(this.scratch.x, this.scratch.y, this.scratch.z);
      mesh.rotation.y = time * 4;
    }
  }
}
