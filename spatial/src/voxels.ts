import * as THREE from "three";
import type { VoxelsResult } from "./types.js";
import type { MeshedBody } from "./cache.js";
import { insideSolid } from "./inside.js";
import { bboxUnion, roundSig, type Bbox, type Vec3 } from "./util.js";

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

// Per-axis (layer, row, col) world-axis assignment. Rows increase downward in
// the printed grid, so the row axis is traversed from max to min.
const LAYOUT: Record<"x" | "y" | "z", { row: number; col: number; rowLabel: string; colLabel: string }> = {
  z: { row: 1, col: 0, rowLabel: "+y to -y", colLabel: "-x to +x" },
  x: { row: 2, col: 1, rowLabel: "+z to -z", colLabel: "-y to +y" },
  y: { row: 2, col: 0, rowLabel: "+z to -z", colLabel: "-x to +x" },
};

export function computeVoxels(
  items: MeshedBody[],
  units: string,
  res: number,
  axis: "x" | "y" | "z",
): VoxelsResult {
  const bbox: Bbox = bboxUnion(items.map((i) => i.info.bbox));
  const dims: Vec3 = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  ];
  const clamped = Math.max(4, Math.min(48, Math.round(res)));
  const maxDim = Math.max(dims[0], dims[1], dims[2], 1e-9);
  const cell = maxDim / clamped;
  const halfDiag = (cell * Math.sqrt(3)) / 2;

  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) n[i] = Math.max(1, Math.ceil(dims[i]! / cell - 1e-9));
  // Report the actual grid bbox so cellSize * res matches it exactly.
  const gridBbox: Bbox = {
    min: [...bbox.min] as Vec3,
    max: [bbox.min[0] + n[0] * cell, bbox.min[1] + n[1] * cell, bbox.min[2] + n[2] * cell],
  };

  // Pre-expand each body's bbox by the fill tolerance for quick rejection.
  const expanded = items.map((it) => {
    const b = it.info.bbox;
    return {
      it,
      min: [b.min[0] - halfDiag, b.min[1] - halfDiag, b.min[2] - halfDiag] as Vec3,
      max: [b.max[0] + halfDiag, b.max[1] + halfDiag, b.max[2] + halfDiag] as Vec3,
    };
  });

  const tmp = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

  function occupied(p: Vec3): boolean {
    for (const e of expanded) {
      if (p[0] < e.min[0] || p[0] > e.max[0] || p[1] < e.min[1] || p[1] > e.max[1] ||
          p[2] < e.min[2] || p[2] > e.max[2]) continue;
      // Surface proximity first (cheap, also catches thin surfaces/walls).
      // maxThreshold only prunes BVH descent; triangles in leaves whose bounds
      // contain the point can still be returned farther away, so re-check.
      tmp.set(p[0], p[1], p[2]);
      const hit = e.it.bm.bvh.closestPointToPoint(tmp, target, 0, halfDiag);
      if (hit && hit.distance <= halfDiag) return true;
      if (e.it.info.kind === "solid" && insideSolid(e.it.bm.bvh, p)) return true;
    }
    return false;
  }

  const layerAxis = AXIS_INDEX[axis];
  const layout = LAYOUT[axis];
  const nLayers = n[layerAxis]!;
  const nRows = n[layout.row]!;
  const nCols = n[layout.col]!;

  let filled = 0;
  const layers: VoxelsResult["layers"] = [];
  for (let li = 0; li < nLayers; li++) {
    const rows: string[] = [];
    for (let r = 0; r < nRows; r++) {
      let row = "";
      for (let c = 0; c < nCols; c++) {
        const p: Vec3 = [0, 0, 0];
        p[layerAxis] = gridBbox.min[layerAxis]! + (li + 0.5) * cell;
        p[layout.row] = gridBbox.min[layout.row]! + (nRows - 1 - r + 0.5) * cell;
        p[layout.col] = gridBbox.min[layout.col]! + (c + 0.5) * cell;
        if (occupied(p)) {
          filled++;
          row += "#";
        } else {
          row += ".";
        }
      }
      rows.push(row);
    }
    layers.push({
      index: li,
      range: [gridBbox.min[layerAxis]! + li * cell, gridBbox.min[layerAxis]! + (li + 1) * cell],
      grid: rows.join("\n"),
    });
  }

  const legend =
    `Voxel occupancy, cubic cells ${roundSig(cell)} ${units}. ` +
    `Layers stacked along ${axis} (layer 0 = lowest ${axis}); ` +
    `grid rows top-to-bottom = ${layout.rowLabel}, columns left-to-right = ${layout.colLabel}. ` +
    `'#' = filled (cell center inside a solid or within ${roundSig(halfDiag)} of a surface), '.' = empty.`;

  return {
    res: n,
    cellSize: [cell, cell, cell],
    bbox: gridBbox,
    axis,
    filled,
    total: n[0] * n[1] * n[2],
    layers,
    legend,
  };
}
