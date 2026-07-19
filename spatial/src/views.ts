import * as THREE from "three";
import type { PickResult, ViewsResult } from "./types.js";
import type { MeshedBody } from "./cache.js";
import { encodePng } from "./png.js";
import { bboxCenter, niceStep, roundSig, type Bbox } from "./util.js";

interface ViewDef {
  name: "top" | "front" | "right" | "iso";
  ox: number; oy: number;          // tile origin in the 2x2 sheet
  dir: THREE.Vector3;              // view direction (into the screen)
  right: THREE.Vector3;            // screen +x in world space
  up: THREE.Vector3;               // screen +y in world space
}

/** Shared camera parameters — pickPixel must reproduce renderViews exactly. */
function cameraSetup(bbox: Bbox) {
  const c = bboxCenter(bbox);
  const center = new THREE.Vector3(c[0], c[1], c[2]);
  const radius = Math.max(
    1e-6,
    0.5 * Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]),
  );
  return { center, radius, ext: radius * 1.15, camOffset: 2 * radius };
}

function viewDefs(tile: number): ViewDef[] {
  const isoDir = new THREE.Vector3(-1, -1, -1).normalize();
  const isoRight = new THREE.Vector3().crossVectors(isoDir, new THREE.Vector3(0, 0, 1)).normalize();
  const isoUp = new THREE.Vector3().crossVectors(isoRight, isoDir).normalize();
  return [
    { name: "top", ox: 0, oy: 0, dir: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    { name: "front", ox: tile, oy: 0, dir: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
    { name: "right", ox: 0, oy: tile, dir: new THREE.Vector3(-1, 0, 0), right: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
    { name: "iso", ox: tile, oy: tile, dir: isoDir, right: isoRight, up: isoUp },
  ];
}

function rayForPixel(
  view: ViewDef,
  cam: ReturnType<typeof cameraSetup>,
  tile: number,
  px: number,   // tile-local pixel
  py: number,
  ray: THREE.Ray,
): void {
  const uu = ((px + 0.5 - tile / 2) / (tile / 2)) * cam.ext;
  const vv = ((tile / 2 - (py + 0.5)) / (tile / 2)) * cam.ext;
  ray.origin
    .copy(cam.center)
    .addScaledVector(view.right, uu)
    .addScaledVector(view.up, vv)
    .addScaledVector(view.dir, -cam.camOffset);
  ray.direction.copy(view.dir);
}

/**
 * Identify what is under a pixel of a space_views sheet rendered with the SAME
 * ids and tile size. px/py are full-image coordinates (0..2*tile).
 */
export function pickPixel(
  items: MeshedBody[],
  bbox: Bbox,
  tile: number,
  px: number,
  py: number,
): PickResult {
  const size = tile * 2;
  if (px < 0 || py < 0 || px >= size || py >= size) {
    throw new Error(`pixel [${px}, ${py}] outside the ${size}x${size} views image`);
  }
  const cam = cameraSetup(bbox);
  const view = viewDefs(tile).find(
    (v) => px >= v.ox && px < v.ox + tile && py >= v.oy && py < v.oy + tile,
  )!;
  const ray = new THREE.Ray();
  rayForPixel(view, cam, tile, px - view.ox, py - view.oy, ray);

  let best = Infinity;
  let bestBody: MeshedBody | null = null;
  let bestPoint: THREE.Vector3 | null = null;
  for (const it of items) {
    const hit = it.bm.bvh.raycastFirst(ray, THREE.DoubleSide, 0, cam.camOffset * 2);
    if (hit && hit.distance < best) {
      best = hit.distance;
      bestBody = it;
      bestPoint = hit.point.clone();
    }
  }
  return {
    view: view.name,
    pixel: [px, py],
    tile,
    hit: bestBody && bestPoint
      ? {
          id: bestBody.info.id,
          name: bestBody.info.name,
          point: [bestPoint.x, bestPoint.y, bestPoint.z],
          // Distance from the scene-center pixel plane is not meaningful to
          // the agent; report depth from the camera plane instead.
          depth: best,
        }
      : null,
  };
}

/**
 * 2x2 orthographic tile sheet: TL=Top, TR=Front, BL=Right, BR=Iso.
 * Per-pixel BVH raycast, depth-shaded (near = lighter) on white, silhouette
 * and inter-body edges darkened, light-gray world grid at nice spacing.
 * No text in pixels — everything textual goes into `legend`.
 */
export function renderViews(
  items: MeshedBody[],
  bbox: Bbox,
  units: string,
  tile: number,
): ViewsResult {
  const size = tile * 2;
  const img = new Uint8Array(size * size * 3).fill(255);

  const cam = cameraSetup(bbox);
  const { center, radius, ext } = cam;
  const camOffset = cam.camOffset;
  const grid = niceStep((ext * 2) / 8);
  const views = viewDefs(tile);

  const ray = new THREE.Ray();
  const pixelWorld = (ext * 2) / tile;
  const gridTol = pixelWorld * 0.6;

  for (const view of views) {
    const depth = new Float32Array(tile * tile).fill(Infinity);
    const body = new Int16Array(tile * tile).fill(-1);

    for (let py = 0; py < tile; py++) {
      for (let px = 0; px < tile; px++) {
        rayForPixel(view, cam, tile, px, py, ray);
        let best = Infinity;
        let bestBody = -1;
        for (let bi = 0; bi < items.length; bi++) {
          const hit = items[bi]!.bm.bvh.raycastFirst(ray, THREE.DoubleSide, 0, camOffset * 2);
          if (hit && hit.distance < best) {
            best = hit.distance;
            bestBody = bi;
          }
        }
        const pi = py * tile + px;
        depth[pi] = best;
        body[pi] = bestBody;
      }
    }

    // Offset pixel plane coordinates so grid lines are anchored to the world
    // origin's projection (world-aligned grid, consistent across views).
    const originU = -center.dot(view.right);
    const originV = -center.dot(view.up);

    for (let py = 0; py < tile; py++) {
      const vv = ((tile / 2 - (py + 0.5)) / (tile / 2)) * ext;
      for (let px = 0; px < tile; px++) {
        const uu = ((px + 0.5 - tile / 2) / (tile / 2)) * ext;
        const pi = py * tile + px;
        let shade = 255;
        if (body[pi] >= 0) {
          // Hits lie roughly in [camOffset - radius, camOffset + radius].
          const t = (depth[pi]! - (camOffset - radius)) / (2 * radius);
          shade = Math.round(235 - Math.max(0, Math.min(1, t)) * 150);
          // Edges: silhouette against background, depth jumps, body changes.
          const jump = radius * 0.04;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= tile || ny >= tile) continue;
            const ni = ny * tile + nx;
            if (body[ni] !== body[pi] || Math.abs(depth[ni]! - depth[pi]!) > jump) {
              shade = 70;
              break;
            }
          }
        } else {
          // Background: light world-aligned grid.
          const wu = uu - originU;
          const wv = vv - originV;
          const du = Math.abs(wu - Math.round(wu / grid) * grid);
          const dv = Math.abs(wv - Math.round(wv / grid) * grid);
          if (du < gridTol || dv < gridTol) shade = 225;
        }
        const o = ((view.oy + py) * size + view.ox + px) * 3;
        img[o] = img[o + 1] = img[o + 2] = shade;
      }
    }
  }

  // 1px separators between quadrants.
  for (let i = 0; i < size; i++) {
    for (const o of [(tile * size + i) * 3, (i * size + tile) * 3]) {
      img[o] = img[o + 1] = img[o + 2] = 170;
    }
  }

  const names = items.map((i) => i.info.name ?? i.info.id).join(", ");
  const legend =
    `2x2 orthographic views, ${tile}px tiles. ` +
    `TL=Top (+Z looking down; +X right, +Y up). TR=Front (looking +Y; +X right, +Z up). ` +
    `BL=Right (looking -X; +Y right, +Z up). BR=Isometric. ` +
    `Depth shading: lighter = closer to viewer; dark lines = silhouette/depth edges. ` +
    `Grid spacing ${roundSig(grid)} ${units}, anchored at world origin. ` +
    `Scene bbox min [${bbox.min.map((x) => roundSig(x)).join(", ")}] ` +
    `max [${bbox.max.map((x) => roundSig(x)).join(", ")}] ${units}. ` +
    `Bodies: ${names}.`;

  return { png: encodePng(size, size, img), legend };
}
