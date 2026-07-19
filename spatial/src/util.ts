export type Vec3 = [number, number, number];
export interface Bbox { min: Vec3; max: Vec3 }

/** Round to `sig` significant digits. Integers pass through unchanged so
 *  counts (bodyCount, filled, total, ...) are never corrupted. */
export function roundSig(n: number, sig = 4): number {
  if (n === 0 || !Number.isFinite(n) || Number.isInteger(n)) return n === 0 ? 0 : n;
  const digits = Math.ceil(Math.log10(Math.abs(n)));
  const factor = Math.pow(10, sig - digits);
  return Math.round(n * factor) / factor;
}

/** Recursively round every number in plain objects/arrays. Leaves strings,
 *  booleans, null, Buffers and typed arrays untouched. */
export function deepRound<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "number") return roundSig(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object" && (v as object).constructor === Object) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        out[k] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export function bboxDims(b: Bbox): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function bboxCenter(b: Bbox): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function bboxUnion(boxes: Bbox[]): Bbox {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i]! < min[i]!) min[i] = b.min[i]!;
      if (b.max[i]! > max[i]!) max[i] = b.max[i]!;
    }
  }
  return { min, max };
}

/** Euclidean gap between two boxes (0 when overlapping/touching). */
export function bboxGap(a: Bbox, b: Bbox): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const g = Math.max(0, a.min[i]! - b.max[i]!, b.min[i]! - a.max[i]!);
    sum += g * g;
  }
  return Math.sqrt(sum);
}

export function bboxInside(inner: Bbox, outer: Bbox, tol = 0): boolean {
  for (let i = 0; i < 3; i++) {
    if (inner.min[i]! < outer.min[i]! - tol) return false;
    if (inner.max[i]! > outer.max[i]! + tol) return false;
  }
  return true;
}

/** Smallest "nice" step (1/2/5 * 10^k) that is >= raw. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= raw - base * 1e-9) return m * base;
  }
  return 10 * base;
}
