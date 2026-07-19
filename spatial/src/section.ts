import type { SectionResult } from "./types.js";
import type { MeshedBody } from "./cache.js";
import type { Vec3 } from "./util.js";

type Vec2 = [number, number];

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

interface Loop {
  points: Vec2[];
  closed: boolean;
}

/** Even-odd point-in-polygon in 2D. */
function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pointToLoopDistance(p: Vec2, loop: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = pointSegmentDistance(p, loop[i]!, loop[(i + 1) % loop.length]!);
    if (d < best) best = d;
  }
  return best;
}

export function computeSection(
  items: MeshedBody[],
  origin: Vec3,
  normal: Vec3,
  tolerance: number,
): SectionResult {
  const n = norm3(normal);
  // Plane basis: for near-z normals this maps u,v to world x,y.
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = norm3(cross3(ref, n));
  const v = cross3(n, u);
  const d0 = dot3(n, origin);

  const weld = Math.max(tolerance * 2, 1e-9);
  const eps = Math.max(tolerance * 1e-3, 1e-12);

  // 1. Collect triangle/plane crossing segments in plane (u,v) coordinates.
  const segments: [Vec2, Vec2][] = [];
  for (const { bm } of items) {
    const pos = bm.mesh.vertices;
    const idx = bm.mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const pts: Vec2[] = [];
      const vi = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
      const p3: Vec3[] = vi.map((i) => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!] as Vec3);
      const dist = p3.map((p) => dot3(n, p) - d0);

      const push = (p: Vec3) => {
        const q: Vec2 = [
          (p[0] - origin[0]) * u[0] + (p[1] - origin[1]) * u[1] + (p[2] - origin[2]) * u[2],
          (p[0] - origin[0]) * v[0] + (p[1] - origin[1]) * v[1] + (p[2] - origin[2]) * v[2],
        ];
        for (const e of pts) {
          if (Math.hypot(e[0] - q[0], e[1] - q[1]) < weld * 0.5) return;
        }
        pts.push(q);
      };

      for (let e = 0; e < 3; e++) {
        const a = e, b = (e + 1) % 3;
        const da = dist[a]!, db = dist[b]!;
        if (Math.abs(da) <= eps) push(p3[a]!);
        if ((da > eps && db < -eps) || (da < -eps && db > eps)) {
          const s = da / (da - db);
          push([
            p3[a]![0] + s * (p3[b]![0] - p3[a]![0]),
            p3[a]![1] + s * (p3[b]![1] - p3[a]![1]),
            p3[a]![2] + s * (p3[b]![2] - p3[a]![2]),
          ]);
        }
      }
      if (pts.length >= 2) segments.push([pts[0]!, pts[1]!]);
    }
  }

  // 2. Weld endpoints via spatial hash, then stitch segments into chains.
  const nodes: Vec2[] = [];
  const cellMap = new Map<string, number[]>();
  const q = weld;
  const nodeFor = (p: Vec2): number => {
    const ci = Math.round(p[0] / q), cj = Math.round(p[1] / q);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const id of cellMap.get(`${ci + di},${cj + dj}`) ?? []) {
          const e = nodes[id]!;
          if (Math.hypot(e[0] - p[0], e[1] - p[1]) <= weld) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push(p);
    const key = `${ci},${cj}`;
    let list = cellMap.get(key);
    if (!list) cellMap.set(key, (list = []));
    list.push(id);
    return id;
  };

  const segNodes: [number, number][] = [];
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of segments) {
    const na = nodeFor(a), nb = nodeFor(b);
    if (na === nb) continue;
    const sid = segNodes.length;
    segNodes.push([na, nb]);
    for (const nd of [na, nb]) {
      let list = adjacency.get(nd);
      if (!list) adjacency.set(nd, (list = []));
      list.push(sid);
    }
  }

  const used = new Array<boolean>(segNodes.length).fill(false);
  const loops: Loop[] = [];
  for (let s = 0; s < segNodes.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const [start, second] = segNodes[s]!;
    const chain = [start, second];
    // Extend forward from `second`; if it doesn't close, extend backward too.
    for (const endIdx of [1, 0] as const) {
      for (;;) {
        const tip = endIdx === 1 ? chain[chain.length - 1]! : chain[0]!;
        const next = (adjacency.get(tip) ?? []).find((sid) => !used[sid]);
        if (next === undefined) break;
        used[next] = true;
        const [na, nb] = segNodes[next]!;
        const other = na === tip ? nb : na;
        if (endIdx === 1) chain.push(other);
        else chain.unshift(other);
        if (chain[0] === chain[chain.length - 1]) break;
      }
      if (chain[0] === chain[chain.length - 1]) break;
    }
    const closed = chain.length > 2 && chain[0] === chain[chain.length - 1];
    const ids = closed ? chain.slice(0, -1) : chain;
    loops.push({ points: ids.map((i) => nodes[i]!), closed });
  }

  // 3. Per-loop metrics.
  const resultLoops = loops.map((loop) => {
    const pts = loop.points;
    let length = 0;
    const last = loop.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      length += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    let area: number | null = null;
    if (loop.closed) {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
        s += a[0] * b[1] - b[0] * a[1];
      }
      area = Math.abs(s) / 2;
    }
    const min: Vec2 = [Infinity, Infinity], max: Vec2 = [-Infinity, -Infinity];
    for (const p of pts) {
      if (p[0] < min[0]) min[0] = p[0];
      if (p[1] < min[1]) min[1] = p[1];
      if (p[0] > max[0]) max[0] = p[0];
      if (p[1] > max[1]) max[1] = p[1];
    }
    return { closed: loop.closed, length, area, bbox2d: { min, max } };
  });

  // 4. Wall thickness between the two outermost nested closed loops.
  let wallThickness: { min: number; max: number } | null = null;
  const closedIdx = resultLoops
    .map((l, i) => ({ l, i }))
    .filter((x) => x.l.closed && x.l.area !== null)
    .sort((a, b) => b.l.area! - a.l.area!);
  if (closedIdx.length >= 2) {
    const outer = loops[closedIdx[0]!.i]!.points;
    const inner = closedIdx
      .slice(1)
      .find((x) => pointInPolygon(loops[x.i]!.points[0]!, outer));
    if (inner) {
      const innerPts = loops[inner.i]!.points;
      // Sample loop vertices plus edge midpoints.
      const samples: Vec2[] = [];
      for (let i = 0; i < innerPts.length; i++) {
        const a = innerPts[i]!, b = innerPts[(i + 1) % innerPts.length]!;
        samples.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
      let mn = Infinity, mx = -Infinity;
      for (const p of samples) {
        const d = pointToLoopDistance(p, outer);
        if (d < mn) mn = d;
        if (d > mx) mx = d;
      }
      wallThickness = { min: mn, max: mx };
    }
  }

  return {
    plane: { origin, normal: n },
    loops: resultLoops,
    wallThickness,
    tolerance,
  };
}
