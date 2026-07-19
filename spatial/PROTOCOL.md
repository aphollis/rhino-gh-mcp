# spatial-core Protocol & Contract (RFD-001 M1–M4)

This file is the single source of truth for three parallel implementations:
the `spatial-core` TS package (this folder), the Rhino listener adapter
commands (rhino/mcp_listener.py), and the MCP server integration (src/).
Do not deviate from the shapes below; if something is impossible, note it in
code comments and keep the shape (use null).

Conventions: all lengths in document units (reported), all coordinates
[x,y,z] arrays, up-axis "z" for Rhino. Numbers in JSON outputs rounded to 4
significant digits by spatial-core (token thrift). Angles deferred to v2.

## 1. Wire commands implemented by the Rhino listener (TCP 8765, JSON lines)

### space.bodies
```
request:  {"method":"space.bodies","params":{"scope":"all|doc|gh","ids":["<guid-or-handle>", ...]}}
          scope default "all" (doc objects + registered GH handles); ids optional filter.
response: {
  "units": "Millimeters",          // doc.ModelUnitSystem.ToString()
  "upAxis": "z",
  "sceneVersion": 42,              // see §3
  "bodies": [{
     "id": "<doc object guid | gh handle>",
     "name": "<obj name or gh nickname or null>",
     "source": "doc" | "gh",
     "kind": "solid"|"surface"|"mesh"|"curve"|"other",
     "bbox": {"min":[x,y,z], "max":[x,y,z]},
     "volume": 123.4 | null,       // kernel-exact (VolumeMassProperties) when closed, else null
     "area": 12.3 | null,          // AreaMassProperties when applicable
     "centroid": [x,y,z] | null,
     "itemCount": 3 | null,        // GH handles only: number of geometry items merged
     "layer": "Default" | null     // doc objects only
  }]
}
```
kind mapping: closed Brep/Extrusion/closed Mesh → "solid"; open Brep/Surface →
"surface"; open Mesh → "mesh"; Curve → "curve"; else "other".
GH handles: resolve via the existing `_HANDLES` map; for an IGH_Component take
ALL output params' VolatileData items, else the param's own data; convert each
item with `GH_Convert.ToGeometryBase`; aggregate (union bbox, sum volume over
closed items, itemCount). Skip non-geometric items silently.

### space.tessellate
```
request:  {"method":"space.tessellate","params":{"id":"<guid-or-handle>","density":0.5}}
          density 0..1 optional (MeshingParameters(density)), default 0.5.
response: {
  "vertices_b64": "<base64 little-endian float32, xyz interleaved>",
  "indices_b64":  "<base64 little-endian int32, triangle triples>",
  "vertexCount": 1234, "triangleCount": 2345,
  "toleranceEstimate": 0.01,       // bbox-diagonal * 0.002 if unknown
  "units": "Millimeters", "sceneVersion": 42
}
```
Mesh sources: Mesh → as-is; Brep → Mesh.CreateFromBrep(brep, mp) (join all);
Extrusion/SubD → ToBrep() first; GH handle → merge all meshable items into ONE
mesh (Mesh.Append). Then `ConvertQuadsToTriangles()`. Export with
`mesh.Vertices.ToFloatArray()` and `mesh.Faces.ToIntArray(True)` — NEVER
Python per-element loops. Pack via `System.Buffer.BlockCopy` into byte[] then
`System.Convert.ToBase64String`. Curves/points → error "id X is a curve; not
meshable — use space.bodies for its bbox".
All work on the UI thread via run_on_ui. Py2/3 compatible (no f-strings).

## 2. sceneVersion

Module-global int in the listener, starts 1, incremented by the dispatcher
after any SUCCESSFUL call to a mutating method:
gh.add, gh.set_value, gh.connect, gh.disconnect, gh.delete, gh.edit, gh.build,
gh.new, gh.open, gh.recompute, gh.bake, rhino.execute.
Included in both space.* responses. spatial-core caches meshes/BVH keyed by
(id, sceneVersion) and invalidates when the version moves.

## 3. spatial-core public API (spatial/src/index.ts exports)

```ts
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

export class SpatialEngine {
  constructor(adapter: GeometryAdapter);
  digest(opts?: { scope?: "all" | "doc" | "gh"; ids?: string[] }): Promise<DigestResult>;
  measure(op: MeasureOp): Promise<object>;              // shapes in §4
  relations(opts?: { ids?: string[]; maxPairs?: number }): Promise<RelationsResult>;
  voxels(opts?: { ids?: string[]; res?: number; axis?: "x" | "y" | "z" }): Promise<VoxelsResult>;
  section(opts: { ids?: string[]; origin: [number,number,number]; normal: [number,number,number] }): Promise<SectionResult>;
  views(opts?: { ids?: string[]; tile?: number }): Promise<ViewsResult>;
}

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
  bbox: { min: [number,number,number]; max: [number,number,number] };
  axis: "x" | "y" | "z"; filled: number; total: number;
  layers: { index: number; range: [number, number]; grid: string }[]; // '#'=filled '.'=empty, rows separated by \n
  legend: string;
}
export interface SectionResult {
  plane: { origin: [number,number,number]; normal: [number,number,number] };
  loops: { closed: boolean; length: number; area: number | null;
           bbox2d: { min: [number, number]; max: [number, number] } }[];
  wallThickness: { min: number; max: number } | null; // when >=2 nested loops, else null
  tolerance: number;
}
export interface ViewsResult { png: Buffer; legend: string }
```

## 4. measure() result shapes

- distance → `{ op:"distance", a, b, distance, closestPointA:[..], closestPointB:[..], tolerance }`
- bbox     → `{ op:"bbox", ids, bbox:{min,max}, dims:[dx,dy,dz], center:[..] }`
- dims     → `{ op:"dims", id, dims:[dx,dy,dz], bbox:{min,max}, kind, volume }`
- probe    → `{ op:"probe", point, insideOf:[ids], nearest:{ id, distance, closestPoint:[..] } | null }`

## 5. Semantics & implementation notes (spatial-core)

- Deps: `three` + `three-mesh-bvh` only. PNG: implement a minimal encoder
  (RGB, 8-bit) over node:zlib — no extra dependency.
- Tessellatable kinds: solid/surface/mesh. Others excluded from mesh ops but
  present in digest.
- Containment: ray-parity on closed meshes (odd crossings = inside). Only
  claim inside/contains for kind "solid" targets.
- relations(): candidate pairs from bbox overlap/proximity prefilter, capped
  at maxPairs (default 20, report skippedPairs). intersects = BVH
  intersection; else containment test (bbox-inside first, then centroid +
  parity); else clear with clearance = BVH closest distance.
- voxels(): default res 16 on the longest axis (clamp 4..48), cells cubic,
  occupancy = cell-center inside any solid OR within tol of any surface
  (closest-point distance ≤ half cell diagonal for thin surfaces). Layers
  stacked along `axis` (default z), layer 0 = lowest. Grid rows are +y down
  when axis=z (document row/col orientation in legend).
- section(): collect triangle-plane crossing segments per mesh, stitch by
  endpoint proximity (weld tol = toleranceEstimate*2) into loops. area via
  shoelace in plane coords for closed loops. wallThickness: min/max distance
  between the two outermost nested loops' sample points.
- views(): 2x2 tiles (tile default 240px): TL=Top(+Z looking down, x right/y up),
  TR=Front(looking +Y, x right/z up), BL=Right(looking -X, y right/z up),
  BR=Iso. Orthographic per-pixel BVH raycast, depth-shaded (near=light), body
  silhouette edges darker, light grid at "nice" spacing (1/2/5*10^k), no text
  in pixels — everything textual goes in `legend`.
- Rounding: helper roundSig(n, 4) applied to all output numbers.
- Caching: Map<(id + ":" + sceneVersion), {mesh, bvh, geometry}>; drop stale
  versions lazily.

## 6. MCP tools (registered in src/index.ts; names shared with future Fusion server)

space_digest, space_measure, space_relations, space_voxels, space_section,
space_views. views returns MCP image content (PNG base64) + legend text; all
others return JSON text.
