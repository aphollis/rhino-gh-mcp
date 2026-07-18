// Generates docs/gh_reference.json by sweeping the live Grasshopper component
// library through the running Rhino listener (port 8765). Instantiates a
// curated set of common components and records their exact input/output param
// names, so the agent never has to call gh_component_info for them.
//
//   node tools/gen_reference.mjs
//
// Rhino must be open with the listener running and Grasshopper launched.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "docs", "gh_reference.json");
const PORT = 8765;

// Curated list of the components the agent reaches for most in parametric work.
const COMMON = [
  // Maths
  "Addition", "Subtraction", "Multiplication", "Division", "Series", "Range",
  "Remap Numbers", "Bounds", "Random", "Pi", "Sine", "Cosine",
  // Vector / point
  "Construct Point", "Deconstruct Point", "Point", "Unit X", "Unit Y", "Unit Z",
  "Vector 2Pt", "Vector XYZ", "Amplitude", "Cross Product", "Distance",
  // Curve
  "Line", "Line SDL", "Circle", "Circle CNR", "Arc", "Polyline", "Rectangle",
  "Interpolate", "Nurbs Curve", "Divide Curve", "Evaluate Curve", "End Points",
  "Curve Middle", "Offset", "Length", "Flip Curve", "Join Curves", "Explode",
  // Surface / solid
  "Extrude", "Extrude Point", "Loft", "Sweep1", "Sweep2", "Revolution",
  "Pipe", "Boundary Surfaces", "Cap Holes", "Offset Surface", "Box", "Sphere",
  "Cylinder", "Surface From Points", "Fragment Patch",
  // Transform
  "Move", "Rotate", "Rotate 3D", "Scale", "Scale NU", "Mirror", "Orient",
  "Rectangular Array", "Polar Array", "Linear Array",
  // Sets / trees
  "List Item", "List Length", "Cull Pattern", "Cull Index", "Dispatch", "Weave",
  "Shift List", "Partition List", "Flatten Tree", "Graft Tree", "Merge",
  "Entwine", "Cross Reference", "Sort List", "Reverse List",
  // Intersect / boolean
  "Solid Union", "Solid Difference", "Solid Intersection", "Trim Solid",
  "Curve | Curve", "Brep | Plane", "Region Intersection", "Region Union",
  // Grid / region / mesh
  "Voronoi", "Delaunay Mesh", "Populate 2D", "Populate 3D", "Convex Hull",
  "Square", "Hexagonal", "Rectangular", "Triangular", "Mesh Sphere", "Mesh Box",
  "Construct Mesh", "Mesh Brep", "Weaverbird's Catmull-Clark Subdivision",
];

function call(sock, id, method, params) {
  return new Promise((resolve, reject) => {
    const handlers = call._h || (call._h = new Map());
    handlers.set(id, { resolve, reject });
    sock.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

async function main() {
  const sock = net.createConnection({ host: "127.0.0.1", port: PORT });
  let buf = "";
  const handlers = new Map();
  call._h = handlers;
  sock.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const h = handlers.get(msg.id);
      if (!h) continue;
      handlers.delete(msg.id);
      if (msg.error) h.reject(new Error(msg.error.message));
      else h.resolve(msg.result);
    }
  });
  await new Promise((r) => sock.once("connect", r));

  let id = 1;
  await call(sock, id++, "gh.launch", {});

  const py = `
import json
import Grasshopper as GH

def safe(v):
    try: return str(v)
    except: return None

wanted = ${JSON.stringify(COMMON)}
low = dict((w.lower(), w) for w in wanted)
found = {}
for p in GH.Instances.ComponentServer.ObjectProxies:
    try:
        if p.Obsolete: continue
    except: pass
    d = p.Desc
    name = safe(d.Name) or ""
    key = name.lower()
    if key not in low or key in found:
        continue
    try:
        obj = p.CreateInstance()
    except:
        continue
    if not hasattr(obj, "Params"):
        continue
    ins = [safe(x.Name) for x in obj.Params.Input]
    outs = [safe(x.Name) for x in obj.Params.Output]
    cat = ""
    try: cat = (safe(d.Category) or "") + ">" + (safe(d.SubCategory) or "")
    except: pass
    found[key] = {"name": name, "category": cat, "guid": safe(p.Guid),
                  "in": ins, "out": outs}

result = json.dumps({"components": list(found.values()),
                     "missing": [w for w in wanted if w.lower() not in found]})
`;
  const res = await call(sock, id++, "rhino.execute", { code: py });
  sock.end();

  const data = JSON.parse(res.result);
  data.components.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log(`Wrote ${data.components.length} components to ${OUT}`);
  if (data.missing.length)
    console.log(`Not found (skipped): ${data.missing.join(", ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
