import type { GeometryAdapter, SceneInfo, MeshData } from "spatial-core";
import { RhinoBridge } from "./bridge.js";

/**
 * GeometryAdapter over the Rhino listener's space.* wire commands
 * (PROTOCOL.md §1 in the spatial-core package). Decodes base64 mesh
 * buffers into typed arrays.
 */
export class RhinoGeometryAdapter implements GeometryAdapter {
  constructor(private bridge: RhinoBridge) {}

  async bodies(scope?: "all" | "doc" | "gh", ids?: string[]): Promise<SceneInfo> {
    return (await this.bridge.call("space.bodies", { scope, ids }, 120_000)) as SceneInfo;
  }

  async tessellate(id: string, density?: number): Promise<MeshData> {
    const r = await this.bridge.call("space.tessellate", { id, density }, 180_000);
    const vb = Buffer.from(r.vertices_b64, "base64");
    const ib = Buffer.from(r.indices_b64, "base64");
    // Copy into fresh ArrayBuffers so the typed-array views are 4-byte aligned.
    const vertices = new Float32Array(
      vb.buffer.slice(vb.byteOffset, vb.byteOffset + vb.byteLength),
    );
    const indices = new Uint32Array(
      ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength),
    );
    return {
      vertices,
      indices,
      tolerance: r.toleranceEstimate ?? 0,
      sceneVersion: r.sceneVersion ?? 0,
    };
  }
}
