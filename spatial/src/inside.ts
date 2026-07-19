import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh/src/index.js";

// Rays are nominally axis-aligned (+X primary) but skewed slightly so they
// never graze edges/vertices of axis-aligned meshes, which would double-count
// crossings and flip parity.
const DIRS = [
  new THREE.Vector3(1, 0.0731, 0.0349).normalize(),
  new THREE.Vector3(0.0293, 1, 0.0517).normalize(),
  new THREE.Vector3(0.0431, 0.0257, 1).normalize(),
];

function crossings(bvh: MeshBVH, point: THREE.Vector3, dir: THREE.Vector3): number {
  const ray = new THREE.Ray(point, dir);
  return bvh.raycast(ray, THREE.DoubleSide).length;
}

/**
 * Ray-parity containment: odd crossings = inside the solid material.
 * Majority vote over three rays for robustness. Only meaningful for closed
 * ("solid") meshes — callers must gate on kind.
 */
export function insideSolid(bvh: MeshBVH, point: [number, number, number]): boolean {
  const p = new THREE.Vector3(point[0], point[1], point[2]);
  let odd = 0;
  for (const d of DIRS) {
    if (crossings(bvh, p, d) % 2 === 1) odd++;
  }
  return odd >= 2;
}

/**
 * Weaker "enclosed" test for relations(): true when the point is in the solid
 * material (parity) OR surrounded by the mesh surface on both sides of a line
 * through it — which catches bodies sitting inside a cavity of a hollow solid,
 * where plain parity reports outside. Only used after a bbox-inside prefilter.
 */
export function enclosedBy(bvh: MeshBVH, point: [number, number, number]): boolean {
  const p = new THREE.Vector3(point[0], point[1], point[2]);
  const d = DIRS[0]!;
  const fwd = crossings(bvh, p, d);
  if (fwd % 2 === 1) return true;
  if (fwd === 0) return false;
  const back = crossings(bvh, p, d.clone().negate());
  return back > 0;
}
