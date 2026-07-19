# RFD-001: Spatial Reasoning Harness

**Status:** Accepted (2026-07-18); M1–M4 implemented same day (spatial-core 30/30
synthetic tests passing; live validation + M3 benchmark pending) · **Scope:**
rhino-gh-mcp now, Fusion 360 MCP later

## 1. Problem

The agent's only 3D perception today is viewport screenshots: a single lossy 2D
projection from which it must guess depth, scale, occlusion, and containment.
Vision is good for gestalt ("looks like a twisted tower") and bad for precision
("is the slab clear of the columns?", "is it hollow?", "how thick is the wall?").

Goal: give the agent **structured, queryable, symbolic representations of
spatial truth** — the channel LLMs actually reason well over — with images
demoted to a complementary gestalt channel. Must be buildable once and reusable
by a future Fusion 360 MCP server.

## 2. Core hypothesis (and its honest status)

| Channel | Hypothesis | Confidence |
|---|---|---|
| Metric digest (bbox, volume, centroid, dims) | Strictly better than screenshots for size/position questions | High — it's exact numbers |
| Spatial queries (distance, containment, clearance) | Same | High |
| Relations (A inside B, A touches B) | Same | High |
| Voxel occupancy as ASCII z-layers | Gives the model a reconstructable volumetric "mental model" (hollowness, mass distribution) | **Medium — this is an experiment.** LLMs handle 2D ASCII grids adequately; integrating 16 stacked layers into a 3D model is plausible but unproven. Ship behind a benchmark (§8); keep if it measurably improves answers, cut if not. |
| Neutral multiview (labeled ortho 4-up) | Better than one perspective screenshot for form disambiguation | High (it's why engineering drawings exist) |
| Semantic features ("4 through-holes Ø3") | Most design-native channel | High value, high cost, kernel-sensitive → **out of scope v1** |

## 3. The load-bearing architecture insight

The v0 sketch had the adapter implementing ~6 kernel queries (pointInside,
section, distance, …). Stress-testing this: **almost everything is derivable in
the shared core from a triangle mesh.**

- distance/closest points → mesh BVH query
- containment → ray-parity test on closed mesh
- collision/contact → BVH triangle-triangle intersection
- sections → mesh-plane intersection, stitched into loops
- voxels → per-cell inside/outside via BVH
- multiview → orthographic per-pixel raycast against BVH (no GPU, no viewport)

So the **required adapter surface shrinks to two primitives**:

```
bodies(scope)            → id, name, bbox, units, up-axis, sceneVersion,
                           kernel-exact volume/area/centroid, isSolid
tessellate(id, tol)      → triangle mesh (base64 vertex/index buffers)
```

plus one optional accelerator tier (exact kernel distance, exact section) that
an adapter *may* provide for precision upgrades. Everything else — all
intelligence, all MCP tool definitions, the voxelizer, the raycaster — lives in
the platform-neutral core. Both Rhino (RhinoCommon) and Fusion (BRepBody +
meshManager, which exposes exactly these) can satisfy this trivially. **The
Fusion adapter becomes an afternoon, not a project.**

Consequences:
- Mesh-derived answers are approximate at tessellation tolerance; every such
  output carries `±tol`. Digest values (volume/area/centroid) are kernel-exact
  because `bodies()` supplies them natively on both platforms.
- Heavy compute (BVH, voxelize, raycast) runs in the **Node process, off
  Rhino's UI thread** — the UI thread has been our scarcest resource all along.

## 4. Design

```
┌─ spatial/ (platform-neutral TS package, extraction-ready) ────────────┐
│  core:  mesh cache · BVH · queries · relations · voxelizer ·          │
│         section stitcher · ortho raycaster/renderer                   │
│  tools: space_digest · space_measure · space_relations ·              │
│         space_voxels · space_section · space_views                    │
└───────────────────────────▲───────────────────────────────────────────┘
                    GeometryAdapter (bodies + tessellate [+ accelerators])
        ┌───────────────────┴────────────────┐
   Rhino listener (RhinoCommon)         Fusion add-in (future)
   - doc objects by id                  - BRepBody via meshManager
   - GH volatile geometry by HANDLE     - kernel-exact props from API
```

**Dependencies:** `three` + `three-mesh-bvh` (pure JS, MIT, no native deps) —
battle-tested BVH raycast/closest-point/intersects. This de-risks the entire
geometry-query layer; we write plumbing, not computational geometry.

**Grasshopper volatile geometry is first-class.** The Rhino adapter resolves
ids that are GH handles (`tower`, `voronoi`) to component output geometry via
`GH_Convert.ToGeometryBase` + meshing — so the agent can measure what a recipe
produced *without baking*. This composes directly with the Phase-2 handle
system and is a genuine differentiator.

**Conventions:** every payload carries units and up-axis (Rhino Z-up, Fusion
Y-up); the core normalizes reports to Z-up and states it. All outputs carry
units.

**Caching & versioning:** the listener increments a `sceneVersion` on every
mutating command (gh.build/edit/set/delete/open/new, rhino.execute, bake).
Core caches meshes per (id, version). No hashing of geometry needed — all
mutations flow through our own tools.

**Transport:** meshes cross the TCP bridge as base64 Float32/Uint32 buffers
(1.33× overhead), packed listener-side with .NET `BitConverter`/`BlockCopy`
(fast even from IronPython), not per-number JSON.

## 5. Tool surface (6 tools, preloaded like the rest)

| Tool | Returns | Token shape |
|---|---|---|
| `space_digest` | per-body: name, dims, bbox, volume, area, centroid, solid? | ~40 tok/body, scope filter |
| `space_measure` | distance/closest-points, angle, bbox of set, point-probe | pay-per-question |
| `space_relations` | contains/intersects/clear + clearance dist, for given ids or bbox-prefiltered pairs | capped pairs |
| `space_voxels` | 16³ default ASCII z-layers (`.`/`#`), region+axis+res params | ~1.4k tok @16³ |
| `space_section` | profile loops at a plane, with per-loop dims + wall thicknesses | ~100-300 tok |
| `space_views` | **PNG** 4-up labeled ortho (top/front/right/iso) w/ scale grid, depth-shaded | image channel |

Decision: views are **PNG via the image content channel**, not ASCII — vision
handles shaded orthos well and it's cheaper than 4×64-line ASCII. ASCII is
reserved for voxels, where the point is symbolic layer-by-layer reasoning.

## 6. Decisions (previously open questions)

1. **Where does the core live?** `spatial/` package inside this repo with its
   own package.json (file: dependency), zero imports from server code —
   extraction-ready when the Fusion server starts. Full monorepo split deferred
   until it exists.
2. **How deep does v1 go?** M1–M3 committed (digest/measure/relations/voxels);
   M4 (views+sections) follows immediately after; Tier-3 semantic features
   explicitly out of scope.
3. **Voxels** ship as an experiment gated on the spatial benchmark (§8).
4. Existing `rhino_capture_viewport` (real render, materials) stays unchanged;
   `space_views` is the neutral geometric channel.

## 7. Risks

- **Mesh payload size** — mitigated by tolerance param, per-version caching,
  and meshing only queried bodies. Worst case: decimation pass in core.
- **Voxel channel may not help** — that's why it's benchmarked, not assumed.
- **IronPython packing perf** — use .NET buffer APIs, never Python loops.
- **Tool budget** — 6 new tools ≈ modest cached-prefix growth; consistent with
  the Phase-1 alwaysLoad strategy.

## 8. Validation: spatial benchmark (extends bench/)

Ground-truth tasks, each scored automatically, run with and without the new
tools:

1. "How tall is the tallest object?" (digest)
2. "Do bodies A and B collide? Clearance?" (relations)
3. "Is this box hollow or solid?" (voxels — the experiment's gate)
4. "What's the wall thickness of this shell?" (section)
5. "Which object is furthest from the origin along X?" (digest/measure)
6. "Does the tower fit inside a 10×10×50 envelope?" (measure)

Success = higher answer accuracy and/or fewer turns vs. screenshot-only.

## 9. Milestones

| # | Deliverable | Contents |
|---|---|---|
| M1 | Neutral protocol + Rhino adapter + `space_digest` | listener: bodies()/tessellate() + sceneVersion + GH-handle resolution; core: mesh cache; digest tool |
| M2 | `space_measure` + `space_relations` | three-mesh-bvh integration; distance/containment/collision/angle |
| M3 | `space_voxels` + spatial benchmark | voxelizer; bench tasks 1-3,5,6; go/no-go data on voxel channel |
| M4 | `space_views` + `space_section` | ortho raycaster → PNG 4-up; mesh-plane section loops + thickness |
| M5 | Fusion adapter (future, separate effort) | BRepBody→protocol; reuses everything above |

Ordering rationale: M1 forces the protocol; M2 is the highest-value query
layer; M3 gates the experiment early; M4 builds on the same BVH raycast infra.
