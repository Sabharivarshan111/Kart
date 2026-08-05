import * as THREE from 'three';
import { CONFIG } from '../core/config.ts';
import { COMMON, KART_COLOURS } from '../core/palette.ts';
import { MeshBuilder } from './geombuild.ts';

/**
 * The kart's presentation mesh, generated in code.
 *
 * Modelled at real scale — 1.9 m long, 1.28 m across the wheels, 1.05 m
 * wheelbase — so it sits correctly against a track authored in metres and the
 * chase camera distance means something.
 *
 * Shapes are chosen to give the edge detector something to find: the nose meets
 * the floor pan at a hard crease, the sidepods stand proud of the chassis, and
 * the seat back breaks the silhouette. A smooth blob would outline beautifully
 * and have no interior lines at all, which is how you end up with a kart that
 * reads as a sticker.
 */

export interface KartGeometry {
  body: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  driver: THREE.BufferGeometry;
}

const K = CONFIG.kart;

export function buildKartGeometry(bodyColourKey: string, accentKey: string): KartGeometry {
  const body = KART_COLOURS[bodyColourKey] ?? KART_COLOURS.ember!;
  const accent = KART_COLOURS[accentKey] ?? KART_COLOURS.amber!;
  return {
    body: buildBody(body, accent),
    wheel: buildWheel(),
    driver: buildDriver(body),
  };
}

function buildBody(colour: number, accent: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const halfL = K.length / 2;

  // Floor pan. The lowest thing on the kart and the reference every other
  // height is measured from.
  b.box(0, 0.14, -0.05, 0.78, 0.09, halfL * 1.55, colour);

  // Side rails, standing proud of the pan so the id/normal edges have a crease
  // to land on rather than a flush join.
  b.box(-0.47, 0.20, -0.05, 0.16, 0.16, halfL * 1.45, accent);
  b.box(0.47, 0.20, -0.05, 0.16, 0.16, halfL * 1.45, accent);

  // Nose: a wedge, tapering to a low leading edge.
  b.wedge(0, 0.24, halfL - 0.28, 0.80, 0.26, 0.62, 0.07, colour);
  // Front fairing, a separate block so the join is a hard line.
  b.box(0, 0.20, halfL - 0.02, 0.94, 0.15, 0.16, accent);

  // Seat: back and base. Breaks the silhouette from behind, which is the view
  // the player spends the entire race looking at.
  b.box(0, 0.44, -0.30, 0.52, 0.40, 0.11, colour, 0.86, 1);
  b.box(0, 0.24, -0.16, 0.50, 0.08, 0.34, colour);

  // Engine block, offset to one side as a real kart's is. Asymmetry is what
  // stops the mesh reading as a toy.
  b.box(0.40, 0.34, -0.46, 0.28, 0.28, 0.38, COMMON.chrome);
  b.cylinder(0.40, 0.52, -0.46, 0.05, 0.16, 6, COMMON.chrome);
  // Exhaust
  b.cylinder(0.30, 0.40, -0.74, 0.045, 0.34, 6, COMMON.chrome);

  // Steering column and wheel.
  const col = new THREE.Matrix4().makeRotationX(-0.55);
  col.setPosition(0, 0.40, 0.16);
  b.setTransform(col);
  b.cylinder(0, 0.10, 0, 0.022, 0.28, 6, COMMON.tyre);
  b.cylinder(0, 0.25, 0, 0.115, 0.03, 10, COMMON.tyre);
  b.resetTransform();

  // Rear bumper and spoiler. The spoiler is the tallest thing on the kart and
  // carries the racing number in the customisation pass.
  b.box(0, 0.30, -halfL - 0.03, 1.02, 0.13, 0.10, accent);
  b.box(-0.30, 0.46, -halfL + 0.02, 0.06, 0.28, 0.05, COMMON.chrome);
  b.box(0.30, 0.46, -halfL + 0.02, 0.06, 0.28, 0.05, COMMON.chrome);
  b.box(0, 0.62, -halfL + 0.02, 0.86, 0.09, 0.20, accent);

  // Front bumper hoop.
  b.box(-0.36, 0.16, halfL + 0.05, 0.06, 0.06, 0.22, COMMON.chrome);
  b.box(0.36, 0.16, halfL + 0.05, 0.06, 0.06, 0.22, COMMON.chrome);

  return b.build();
}

function buildWheel(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // Built along Y, then rotated onto X, because the axle is across the kart.
  const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
  b.setTransform(rot);
  // 10 sides: at the chase camera's distance an 8-sided wheel reads as
  // faceted when it spins, and 16 costs triangles on eight wheels at once for
  // no visible gain.
  b.cylinder(0, 0, 0, K.wheelRadius, 0.20, 10, COMMON.tyre, COMMON.tyre);
  b.cylinder(0, 0, 0, K.wheelRadius * 0.55, 0.215, 10, COMMON.rim, COMMON.rim);
  b.resetTransform();
  return b.build();
}

function buildDriver(suitColour: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // Seated, leaning back a little. Sized against the kart rather than against a
  // person: a correctly-proportioned human in a kart is mostly invisible.
  b.box(0, 0.52, -0.10, 0.40, 0.34, 0.26, suitColour, 0.88, 0.9);
  // Shoulders
  b.box(0, 0.68, -0.10, 0.46, 0.12, 0.24, suitColour);
  // Head and helmet: the helmet is a tapered box so its top catches a different
  // cel band from its sides.
  b.box(0, 0.84, -0.06, 0.26, 0.24, 0.27, COMMON.driverSkinA, 0.82, 0.82);
  b.box(0, 0.845, -0.055, 0.285, 0.20, 0.30, suitColour, 0.9, 0.9);
  // Visor: a dark band across the front, which is what makes a helmet read as
  // a helmet at 60 px on screen.
  b.box(0, 0.85, 0.10, 0.24, 0.09, 0.03, COMMON.visor);

  // Arms out to the wheel. Two segments each so the elbow makes a crease.
  const upperL = new THREE.Matrix4().makeRotationX(0.85);
  upperL.setPosition(-0.20, 0.62, -0.02);
  b.setTransform(upperL);
  b.box(0, 0, 0.14, 0.11, 0.11, 0.30, suitColour);
  b.resetTransform();
  const upperR = new THREE.Matrix4().makeRotationX(0.85);
  upperR.setPosition(0.20, 0.62, -0.02);
  b.setTransform(upperR);
  b.box(0, 0, 0.14, 0.11, 0.11, 0.30, suitColour);
  b.resetTransform();
  b.box(-0.14, 0.47, 0.20, 0.10, 0.10, 0.20, COMMON.driverSkinA);
  b.box(0.14, 0.47, 0.20, 0.10, 0.10, 0.20, COMMON.driverSkinA);

  return b.build();
}

/** Wheel positions in kart-local space. Front wheels steer; all four spin. */
export const WHEEL_OFFSETS: readonly { x: number; z: number; front: boolean }[] = [
  { x: -K.trackWidth / 2, z: K.wheelbase / 2, front: true },
  { x: K.trackWidth / 2, z: K.wheelbase / 2, front: true },
  { x: -K.trackWidth / 2, z: -K.wheelbase / 2, front: false },
  { x: K.trackWidth / 2, z: -K.wheelbase / 2, front: false },
];
