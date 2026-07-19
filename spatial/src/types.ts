/**
 * Public types for spatial-core, verbatim per PROTOCOL.md §3.
 */

export interface BodyInfo {
  id: string; name: string | null; source: "doc" | "gh";
  kind: "solid" | "surface" | "mesh" | "curve" | "other";
  bbox: { min: [number, number, number]; max: [number, number, number] };
  volume: number | null; area: number | null;
  centroid: [number, number, number] | null;
  itemCount: number | null; layer: string | null;
}

export interface SceneInfo {
  units: string; upAxis: "z"; sceneVersion: number; bodies: BodyInfo[];
}

export interface MeshData {
  vertices: Float32Array; indices: Uint32Array;
  tolerance: number; sceneVersion: number;
}

export interface GeometryAdapter {
  bodies(scope?: "all" | "doc" | "gh", ids?: string[]): Promise<SceneInfo>;
  tessellate(id: string, density?: number): Promise<MeshData>;
}

export type MeasureOp =
  | { op: "distance"; a: string; b: string }
  | { op: "bbox"; ids: string[] }
  | { op: "dims"; id: string }
  | { op: "probe"; point: [number, number, number] };

export interface DigestResult extends SceneInfo {
  bodyCount: number;
  bodies: (BodyInfo & { dims: [number, number, number] })[];
}

export interface RelationsResult {
  pairs: { a: string; b: string;
           relation: "clear" | "intersects" | "a_inside_b" | "b_inside_a";
           clearance: number | null; }[];
  tolerance: number; skippedPairs: number;
}

export interface VoxelsResult {
  res: [number, number, number]; cellSize: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] };
  axis: "x" | "y" | "z"; filled: number; total: number;
  layers: { index: number; range: [number, number]; grid: string }[]; // '#'=filled '.'=empty, rows separated by \n
  legend: string;
}

export interface SectionResult {
  plane: { origin: [number, number, number]; normal: [number, number, number] };
  loops: { closed: boolean; length: number; area: number | null;
           bbox2d: { min: [number, number]; max: [number, number] } }[];
  wallThickness: { min: number; max: number } | null; // when >=2 nested loops, else null
  tolerance: number;
}

export interface ViewsResult { png: Buffer; legend: string }
