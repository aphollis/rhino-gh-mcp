import type { FitResult } from "./types.js";
import type { MeshedBody } from "./cache.js";
import { makeOccupancyTest } from "./voxels.js";
import { roundSig, type Bbox, type Vec3 } from "./util.js";

/**
 * Free-space/placement search: find axis-aligned positions where a box of
 * `dims` fits with `clearance` on all sides, avoiding the obstacle bodies.
 * Voxelizes the search region and uses a 3D summed-area table so every
 * candidate window is an O(1) query.
 */
export function computeFit(
  items: MeshedBody[],
  units: string,
  dims: Vec3,
  clearance: number,
  region: Bbox,
  resOpt: number | undefined,
  target: Vec3,
  maxResults: number,
): FitResult {
  const padded: Vec3 = [
    dims[0] + 2 * clearance,
    dims[1] + 2 * clearance,
    dims[2] + 2 * clearance,
  ];
  const regionDims: Vec3 = [
    region.max[0] - region.min[0],
    region.max[1] - region.min[1],
    region.max[2] - region.min[2],
  ];
  for (let i = 0; i < 3; i++) {
    if (padded[i]! > regionDims[i]! + 1e-9) {
      return {
        fits: false, dims, clearance, region, cellSize: 0,
        totalPlacements: 0, candidates: [],
        note: "The part (plus clearance) is larger than the search region along at least one axis.",
      };
    }
  }

  const res = Math.max(8, Math.min(64, Math.round(resOpt ?? 32)));
  const maxDim = Math.max(regionDims[0], regionDims[1], regionDims[2], 1e-9);
  // Cell must not exceed the smallest padded-part axis, or the window would
  // be a single cell and sub-cell collisions could slip through.
  const cell = Math.min(maxDim / res, Math.max(Math.min(...padded) / 2, 1e-9));
  const halfDiag = (cell * Math.sqrt(3)) / 2;

  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) n[i] = Math.max(1, Math.ceil(regionDims[i]! / cell - 1e-9));
  const [nx, ny, nz] = n;

  // Occupancy grid at cell centers.
  const occupied = makeOccupancyTest(items, halfDiag);
  const occ = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const p: Vec3 = [
          region.min[0] + (x + 0.5) * cell,
          region.min[1] + (y + 0.5) * cell,
          region.min[2] + (z + 0.5) * cell,
        ];
        if (occupied(p)) occ[idx(x, y, z)] = 1;
      }

  // 3D summed-area table, dimensions (n+1)^3, sat[0,*] = 0.
  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const sat = new Int32Array(sx * sy * sz);
  const sidx = (x: number, y: number, z: number) => (z * sy + y) * sx + x;
  for (let z = 1; z < sz; z++)
    for (let y = 1; y < sy; y++)
      for (let x = 1; x < sx; x++) {
        sat[sidx(x, y, z)] =
          occ[idx(x - 1, y - 1, z - 1)]! +
          sat[sidx(x - 1, y, z)]! + sat[sidx(x, y - 1, z)]! + sat[sidx(x, y, z - 1)]! -
          sat[sidx(x - 1, y - 1, z)]! - sat[sidx(x - 1, y, z - 1)]! - sat[sidx(x, y - 1, z - 1)]! +
          sat[sidx(x - 1, y - 1, z - 1)]!;
      }

  function windowSum(x0: number, y0: number, z0: number, wx: number, wy: number, wz: number): number {
    const x1 = x0 + wx, y1 = y0 + wy, z1 = z0 + wz;
    return (
      sat[sidx(x1, y1, z1)]! - sat[sidx(x0, y1, z1)]! - sat[sidx(x1, y0, z1)]! - sat[sidx(x1, y1, z0)]! +
      sat[sidx(x0, y0, z1)]! + sat[sidx(x0, y1, z0)]! + sat[sidx(x1, y0, z0)]! - sat[sidx(x0, y0, z0)]!
    );
  }

  // Window size in cells for the padded part.
  const w: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) w[i] = Math.min(n[i]!, Math.max(1, Math.ceil(padded[i]! / cell)));

  let totalPlacements = 0;
  const top: FitResult["candidates"] = [];
  for (let z = 0; z + w[2]! <= nz; z++)
    for (let y = 0; y + w[1]! <= ny; y++)
      for (let x = 0; x + w[0]! <= nx; x++) {
        if (windowSum(x, y, z, w[0]!, w[1]!, w[2]!) !== 0) continue;
        totalPlacements++;
        const min: Vec3 = [
          region.min[0] + x * cell + clearance,
          region.min[1] + y * cell + clearance,
          region.min[2] + z * cell + clearance,
        ];
        const max: Vec3 = [min[0] + dims[0], min[1] + dims[1], min[2] + dims[2]];
        const center: Vec3 = [
          (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
        ];
        const d = Math.sqrt(
          (center[0] - target[0]) ** 2 + (center[1] - target[1]) ** 2 + (center[2] - target[2]) ** 2,
        );
        if (top.length < maxResults) {
          top.push({ min, max, center, distanceToTarget: d });
          top.sort((a, b) => a.distanceToTarget - b.distanceToTarget);
        } else if (d < top[top.length - 1]!.distanceToTarget) {
          top[top.length - 1] = { min, max, center, distanceToTarget: d };
          top.sort((a, b) => a.distanceToTarget - b.distanceToTarget);
        }
      }

  return {
    fits: totalPlacements > 0,
    dims, clearance, region,
    cellSize: cell,
    totalPlacements,
    candidates: top,
    note:
      "Grid-resolution approximate (cell " + roundSig(cell) + " " + units + "); verify a chosen " +
      "placement with space_measure. Fully enclosed cavities count as free space (they are " +
      "geometrically empty even if physically unreachable).",
  };
}
