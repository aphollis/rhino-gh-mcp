import * as THREE from "three";
import type {
  BodyInfo, DigestResult, GeometryAdapter, MeasureOp, RelationsResult,
  SceneInfo, SectionResult, ViewsResult, VoxelsResult,
} from "./types.js";
import { MeshCache, type MeshedBody } from "./cache.js";
import { enclosedBy, insideSolid } from "./inside.js";
import { computeVoxels } from "./voxels.js";
import { computeSection } from "./section.js";
import { renderViews } from "./views.js";
import {
  bboxCenter, bboxDims, bboxGap, bboxInside, bboxUnion, deepRound, type Vec3,
} from "./util.js";

const IDENTITY = new THREE.Matrix4();

function isTessellatable(b: BodyInfo): boolean {
  return b.kind === "solid" || b.kind === "surface" || b.kind === "mesh";
}

export class SpatialEngine {
  private cache: MeshCache;

  constructor(private adapter: GeometryAdapter) {
    this.cache = new MeshCache(adapter);
  }

  private async meshed(scene: SceneInfo, bodies: BodyInfo[]): Promise<MeshedBody[]> {
    const out: MeshedBody[] = [];
    for (const info of bodies.filter(isTessellatable)) {
      out.push({ info, bm: await this.cache.get(info.id, scene.sceneVersion) });
    }
    return out;
  }

  private findBody(scene: SceneInfo, id: string): BodyInfo {
    const body = scene.bodies.find((b) => b.id === id);
    if (!body) throw new Error(`Unknown body id "${id}"`);
    return body;
  }

  private async meshedBody(scene: SceneInfo, id: string): Promise<MeshedBody> {
    const info = this.findBody(scene, id);
    if (!isTessellatable(info)) {
      throw new Error(`Body "${id}" has kind "${info.kind}" and cannot be meshed`);
    }
    return { info, bm: await this.cache.get(id, scene.sceneVersion) };
  }

  async digest(opts?: { scope?: "all" | "doc" | "gh"; ids?: string[] }): Promise<DigestResult> {
    const scene = await this.adapter.bodies(opts?.scope, opts?.ids);
    return deepRound({
      units: scene.units,
      upAxis: scene.upAxis,
      sceneVersion: scene.sceneVersion,
      bodyCount: scene.bodies.length,
      bodies: scene.bodies.map((b) => ({ ...b, dims: bboxDims(b.bbox) })),
    });
  }

  async measure(op: MeasureOp): Promise<object> {
    switch (op.op) {
      case "distance": {
        const scene = await this.adapter.bodies(undefined, [op.a, op.b]);
        const a = await this.meshedBody(scene, op.a);
        const b = await this.meshedBody(scene, op.b);
        const t1 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        const t2 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        a.bm.bvh.closestPointToGeometry(b.bm.geometry, IDENTITY, t1, t2);
        return deepRound({
          op: "distance", a: op.a, b: op.b,
          distance: t1.distance,
          closestPointA: t1.point.toArray() as Vec3,
          closestPointB: t2.point.toArray() as Vec3,
          tolerance: Math.max(a.bm.mesh.tolerance, b.bm.mesh.tolerance),
        });
      }
      case "bbox": {
        const scene = await this.adapter.bodies(undefined, op.ids);
        const boxes = op.ids.map((id) => this.findBody(scene, id).bbox);
        const bbox = bboxUnion(boxes);
        return deepRound({
          op: "bbox", ids: op.ids, bbox,
          dims: bboxDims(bbox), center: bboxCenter(bbox),
        });
      }
      case "dims": {
        const scene = await this.adapter.bodies(undefined, [op.id]);
        const body = this.findBody(scene, op.id);
        return deepRound({
          op: "dims", id: op.id, dims: bboxDims(body.bbox),
          bbox: body.bbox, kind: body.kind, volume: body.volume,
        });
      }
      case "probe": {
        const scene = await this.adapter.bodies();
        const items = await this.meshed(scene, scene.bodies);
        const insideOf = items
          .filter((it) => it.info.kind === "solid" && insideSolid(it.bm.bvh, op.point))
          .map((it) => it.info.id);
        const p = new THREE.Vector3(op.point[0], op.point[1], op.point[2]);
        let nearest: { id: string; distance: number; closestPoint: Vec3 } | null = null;
        const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        for (const it of items) {
          const hit = it.bm.bvh.closestPointToPoint(p, target);
          if (hit && (!nearest || hit.distance < nearest.distance)) {
            nearest = { id: it.info.id, distance: hit.distance, closestPoint: hit.point.toArray() as Vec3 };
          }
        }
        return deepRound({ op: "probe", point: op.point, insideOf, nearest });
      }
    }
  }

  async relations(opts?: { ids?: string[]; maxPairs?: number }): Promise<RelationsResult> {
    const scene = await this.adapter.bodies(undefined, opts?.ids);
    const items = await this.meshed(scene, scene.bodies);
    const maxPairs = opts?.maxPairs ?? 20;

    // Candidate pairs ordered by bbox proximity (overlapping first), capped.
    const candidates: { a: number; b: number; gap: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        candidates.push({ a: i, b: j, gap: bboxGap(items[i]!.info.bbox, items[j]!.info.bbox) });
      }
    }
    candidates.sort((x, y) => x.gap - y.gap);
    const taken = candidates.slice(0, maxPairs);
    const skippedPairs = candidates.length - taken.length;

    let tolerance = 0;
    const pairs: RelationsResult["pairs"] = [];
    for (const { a: ai, b: bi } of taken) {
      const a = items[ai]!, b = items[bi]!;
      const tol = Math.max(a.bm.mesh.tolerance, b.bm.mesh.tolerance);
      tolerance = Math.max(tolerance, tol);

      let relation: RelationsResult["pairs"][number]["relation"];
      let clearance: number | null = null;

      if (bboxGap(a.info.bbox, b.info.bbox) <= tol &&
          a.bm.bvh.intersectsGeometry(b.bm.geometry, IDENTITY)) {
        relation = "intersects";
      } else if (b.info.kind === "solid" && bboxInside(a.info.bbox, b.info.bbox, tol) &&
                 enclosedBy(b.bm.bvh, bboxCenter(a.info.bbox))) {
        relation = "a_inside_b";
      } else if (a.info.kind === "solid" && bboxInside(b.info.bbox, a.info.bbox, tol) &&
                 enclosedBy(a.bm.bvh, bboxCenter(b.info.bbox))) {
        relation = "b_inside_a";
      } else {
        relation = "clear";
        const t1 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        const t2 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
        a.bm.bvh.closestPointToGeometry(b.bm.geometry, IDENTITY, t1, t2);
        clearance = t1.distance;
      }
      pairs.push({ a: a.info.id, b: b.info.id, relation, clearance });
    }

    return deepRound({ pairs, tolerance, skippedPairs });
  }

  async voxels(opts?: { ids?: string[]; res?: number; axis?: "x" | "y" | "z" }): Promise<VoxelsResult> {
    const scene = await this.adapter.bodies(undefined, opts?.ids);
    const items = await this.meshed(scene, scene.bodies);
    if (items.length === 0) throw new Error("voxels: no tessellatable bodies in scope");
    return deepRound(computeVoxels(items, scene.units, opts?.res ?? 16, opts?.axis ?? "z"));
  }

  async section(opts: {
    ids?: string[];
    origin: [number, number, number];
    normal: [number, number, number];
  }): Promise<SectionResult> {
    const scene = await this.adapter.bodies(undefined, opts.ids);
    const items = await this.meshed(scene, scene.bodies);
    if (items.length === 0) throw new Error("section: no tessellatable bodies in scope");
    const tolerance = Math.max(...items.map((it) => it.bm.mesh.tolerance));
    return deepRound(computeSection(items, opts.origin, opts.normal, tolerance));
  }

  async views(opts?: { ids?: string[]; tile?: number }): Promise<ViewsResult> {
    const scene = await this.adapter.bodies(undefined, opts?.ids);
    const items = await this.meshed(scene, scene.bodies);
    if (items.length === 0) throw new Error("views: no tessellatable bodies in scope");
    const bbox = bboxUnion(items.map((it) => it.info.bbox));
    // legend numbers are already rounded during formatting; png must not be walked.
    return renderViews(items, bbox, scene.units, opts?.tile ?? 240);
  }
}
