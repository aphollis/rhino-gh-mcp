// Plain-node test harness for spatial-core (no framework, no Rhino).
// Run from repo root:  node spatial/test/run-tests.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SpatialEngine } from "../dist/index.js";

// ---------------------------------------------------------------- mesh builders

/** Axis-aligned box mesh with outward CCW winding; invert flips normals. */
function boxMesh(min, max, invert = false) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const vertices = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  let indices = [
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    2, 3, 7, 2, 7, 6, // back (+y)
    0, 4, 7, 0, 7, 3, // left (-x)
    1, 2, 6, 1, 6, 5, // right (+x)
  ];
  if (invert) {
    const flipped = [];
    for (let i = 0; i < indices.length; i += 3) {
      flipped.push(indices[i], indices[i + 2], indices[i + 1]);
    }
    indices = flipped;
  }
  return { vertices: vertices.flat(), indices };
}

/** UV sphere with outward winding (degenerate pole triangles are harmless). */
function sphereMesh(center, r, segs = 48, rings = 24) {
  const vertices = [];
  const indices = [];
  for (let i = 0; i <= rings; i++) {
    const theta = (i * Math.PI) / rings;
    for (let j = 0; j <= segs; j++) {
      const phi = (j * 2 * Math.PI) / segs;
      vertices.push(
        center[0] + r * Math.sin(theta) * Math.cos(phi),
        center[1] + r * Math.sin(theta) * Math.sin(phi),
        center[2] + r * Math.cos(theta),
      );
    }
  }
  const cols = segs + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * cols + j, b = i * cols + j + 1;
      const c = (i + 1) * cols + j + 1, d = (i + 1) * cols + j;
      indices.push(a, d, c, a, c, b);
    }
  }
  return { vertices, indices };
}

function mergeMeshes(...meshes) {
  const vertices = [], indices = [];
  for (const m of meshes) {
    const offset = vertices.length / 3;
    vertices.push(...m.vertices);
    for (const i of m.indices) indices.push(i + offset);
  }
  return { vertices, indices };
}

/** Signed mesh volume via divergence theorem. */
function meshVolume(mesh) {
  const v = mesh.vertices, idx = mesh.indices;
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ax = v[a], ay = v[a + 1], az = v[a + 2];
    const bx = v[b], by = v[b + 1], bz = v[b + 2];
    const cx = v[c], cy = v[c + 1], cz = v[c + 2];
    vol += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

// ---------------------------------------------------------------- synthetic scene

const SPHERE_VOL = (4 / 3) * Math.PI * 125;
const SPHERE_AREA = 4 * Math.PI * 25;

const MESHES = {
  cube: boxMesh([-5, -5, -5], [5, 5, 5]),
  // Hollow box: 20^3 outer shell + inverted-normal 16^3 inner shell, one closed mesh.
  hollow: mergeMeshes(
    boxMesh([-10, -10, -10], [10, 10, 10]),
    boxMesh([-8, -8, -8], [8, 8, 8], true),
  ),
  sphereA: sphereMesh([40, 0, 0], 5),
  sphereB: sphereMesh([70, 0, 0], 5),
};

const BODIES = [
  { id: "cube", name: "cube", source: "doc", kind: "solid",
    bbox: { min: [-5, -5, -5], max: [5, 5, 5] },
    volume: 1000, area: 600, centroid: [0, 0, 0], itemCount: null, layer: "Default" },
  { id: "hollow", name: "hollow box", source: "doc", kind: "solid",
    bbox: { min: [-10, -10, -10], max: [10, 10, 10] },
    volume: 20 ** 3 - 16 ** 3, area: 6 * 400 + 6 * 256, centroid: [0, 0, 0],
    itemCount: null, layer: "Default" },
  { id: "sphereA", name: "sphere A", source: "doc", kind: "solid",
    bbox: { min: [35, -5, -5], max: [45, 5, 5] },
    volume: SPHERE_VOL, area: SPHERE_AREA, centroid: [40, 0, 0], itemCount: null, layer: "Default" },
  { id: "sphereB", name: "sphere B", source: "doc", kind: "solid",
    bbox: { min: [65, -5, -5], max: [75, 5, 5] },
    volume: SPHERE_VOL, area: SPHERE_AREA, centroid: [70, 0, 0], itemCount: null, layer: "Default" },
];

class SyntheticAdapter {
  async bodies(scope, ids) {
    const bodies = BODIES.filter((b) => !ids || ids.includes(b.id));
    return { units: "Millimeters", upAxis: "z", sceneVersion: 1, bodies };
  }

  async tessellate(id) {
    const mesh = MESHES[id];
    if (!mesh) throw new Error(`no mesh for ${id}`);
    const body = BODIES.find((b) => b.id === id);
    const [dx, dy, dz] = [0, 1, 2].map((i) => body.bbox.max[i] - body.bbox.min[i]);
    return {
      vertices: new Float32Array(mesh.vertices),
      indices: new Uint32Array(mesh.indices),
      tolerance: Math.hypot(dx, dy, dz) * 0.002,
      sceneVersion: 1,
    };
  }
}

// ---------------------------------------------------------------- harness

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  }
}
const approx = (actual, expected, pct) =>
  Math.abs(actual - expected) <= Math.abs(expected) * pct;

const engine = new SpatialEngine(new SyntheticAdapter());

// --- digest
{
  const d = await engine.digest();
  check("digest bodyCount", d.bodyCount === 4, `got ${d.bodyCount}`);
  const cube = d.bodies.find((b) => b.id === "cube");
  check("digest cube dims", JSON.stringify(cube?.dims) === "[10,10,10]",
    `got ${JSON.stringify(cube?.dims)}`);
  for (const b of d.bodies) {
    const mv = meshVolume(MESHES[b.id]);
    check(`digest volume ${b.id} within 2% of mesh volume`, approx(mv, b.volume, 0.02),
      `digest ${b.volume} vs mesh ${mv}`);
  }
}

// --- measure: distance
{
  const r = await engine.measure({ op: "distance", a: "sphereA", b: "sphereB" });
  check("measure distance spheres ~20", approx(r.distance, 20, 0.02), `got ${r.distance}`);
  check("measure distance closest points sane",
    Math.abs(r.closestPointA[0] - 45) < 0.5 && Math.abs(r.closestPointB[0] - 65) < 0.5,
    `A=${JSON.stringify(r.closestPointA)} B=${JSON.stringify(r.closestPointB)}`);
}

// --- measure: bbox / dims
{
  const r = await engine.measure({ op: "bbox", ids: ["sphereA", "sphereB"] });
  check("measure bbox spheres dims", JSON.stringify(r.dims) === "[40,10,10]",
    `got ${JSON.stringify(r.dims)}`);
  const d = await engine.measure({ op: "dims", id: "cube" });
  check("measure dims cube", JSON.stringify(d.dims) === "[10,10,10]" && d.volume === 1000,
    `dims ${JSON.stringify(d.dims)} vol ${d.volume}`);
}

// --- measure: probe
{
  const inside = await engine.measure({ op: "probe", point: [0, 0, 0] });
  check("probe origin insideOf cube", inside.insideOf.includes("cube"),
    `got ${JSON.stringify(inside.insideOf)}`);
  check("probe origin not inside hollow (cavity)", !inside.insideOf.includes("hollow"),
    `got ${JSON.stringify(inside.insideOf)}`);

  const far = await engine.measure({ op: "probe", point: [200, 200, 200] });
  check("probe far insideOf empty", far.insideOf.length === 0,
    `got ${JSON.stringify(far.insideOf)}`);
  check("probe far nearest sane",
    far.nearest !== null && far.nearest.distance > 100 && far.nearest.distance < 400 &&
      far.nearest.closestPoint.every(Number.isFinite),
    `got ${JSON.stringify(far.nearest)}`);
}

// --- relations
{
  const r = await engine.relations();
  const find = (a, b) => r.pairs.find(
    (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

  const spheres = find("sphereA", "sphereB");
  check("relations spheres clear", spheres?.relation === "clear",
    `got ${JSON.stringify(spheres)}`);
  check("relations spheres clearance ~20",
    spheres?.clearance !== null && approx(spheres.clearance, 20, 0.02),
    `got ${spheres?.clearance}`);

  const nested = find("cube", "hollow");
  const expected = nested?.a === "cube" ? "a_inside_b" : "b_inside_a";
  check("relations cube inside hollow", nested?.relation === expected,
    `got ${JSON.stringify(nested)}`);
  check("relations no skipped pairs", r.skippedPairs === 0, `got ${r.skippedPairs}`);
}

// --- voxels (hollowness channel)
{
  const v = await engine.voxels({ ids: ["hollow"], res: 12 });
  check("voxels res 12^3", JSON.stringify(v.res) === "[12,12,12]",
    `got ${JSON.stringify(v.res)}`);
  check("voxels total", v.total === 12 ** 3, `got ${v.total}`);
  const mid = v.layers[5];
  const rows = mid.grid.split("\n");
  check("voxels middle layer center empty", rows[5][5] === "." && rows[6][6] === ".",
    `rows5/6: ${rows[5]} / ${rows[6]}`);
  check("voxels middle layer shell filled",
    rows[0] === "#".repeat(12) && rows[11] === "#".repeat(12) &&
      rows[5][0] === "#" && rows[5][11] === "#",
    `layer:\n${mid.grid}`);
  check("voxels bottom layer solid", v.layers[0].grid.split("\n").every((r) => r === "#".repeat(12)),
    `layer0:\n${v.layers[0].grid}`);
}

// --- section (hollow box at z=0)
{
  const s = await engine.section({ ids: ["hollow"], origin: [0, 0, 0], normal: [0, 0, 1] });
  check("section two loops", s.loops.length === 2, `got ${s.loops.length}`);
  check("section loops closed", s.loops.every((l) => l.closed),
    JSON.stringify(s.loops.map((l) => l.closed)));
  const areas = s.loops.map((l) => l.area).sort((a, b) => a - b);
  check("section loop areas ~256/400",
    approx(areas[0], 256, 0.02) && approx(areas[1], 400, 0.02),
    `got ${JSON.stringify(areas)}`);
  check("section wall thickness ~2",
    s.wallThickness !== null &&
      approx(s.wallThickness.min, 2, 0.2) && approx(s.wallThickness.max, 2, 0.2),
    `got ${JSON.stringify(s.wallThickness)}`);
}

// --- views
{
  const v = await engine.views();
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check("views png signature", v.png.subarray(0, 8).equals(sig),
    v.png.subarray(0, 8).toString("hex"));
  check("views png size", v.png.length > 2000, `got ${v.png.length} bytes`);
  check("views legend mentions quadrants",
    /Top/.test(v.legend) && /Front/.test(v.legend) && /Right/.test(v.legend) && /Iso/.test(v.legend),
    v.legend);
  const out = fileURLToPath(new URL("./out-views.png", import.meta.url));
  writeFileSync(out, v.png);
  console.log(`wrote ${out}`);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
