import * as THREE from "three";
// Import from the ESM source entry: the package "main" is a UMD .cjs whose
// named exports Node's ESM interop cannot see. src/index.d.ts sits alongside.
import { MeshBVH } from "three-mesh-bvh/src/index.js";
import type { BodyInfo, GeometryAdapter, MeshData } from "./types.js";

export interface BodyMesh {
  mesh: MeshData;
  geometry: THREE.BufferGeometry;
  bvh: MeshBVH;
}

/** A tessellatable body paired with its cached mesh/BVH. */
export interface MeshedBody {
  info: BodyInfo;
  bm: BodyMesh;
}

/**
 * Mesh + BVH cache keyed by id + ":" + sceneVersion (PROTOCOL §5).
 * Stale versions of the same id are dropped lazily on the next fetch.
 */
export class MeshCache {
  private entries = new Map<string, BodyMesh>();

  constructor(private adapter: GeometryAdapter) {}

  async get(id: string, sceneVersion: number): Promise<BodyMesh> {
    const key = id + ":" + sceneVersion;
    const hit = this.entries.get(key);
    if (hit) return hit;

    for (const k of this.entries.keys()) {
      if (k.startsWith(id + ":")) this.entries.delete(k);
    }

    const mesh = await this.adapter.tessellate(id);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const bvh = new MeshBVH(geometry);
    // Lets three-mesh-bvh use the accelerated path in geometry-vs-geometry ops.
    geometry.boundsTree = bvh;

    const entry: BodyMesh = { mesh, geometry, bvh };
    this.entries.set(key, entry);
    return entry;
  }
}
