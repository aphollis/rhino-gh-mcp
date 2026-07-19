// Spatial reasoning benchmark (RFD-001 §8).
// Creates KNOWN ground-truth geometry in the Rhino doc (via the listener),
// then asks the agent the six RFD questions and scores the answers.
//
//   node bench/spatial.mjs setup    create the test geometry (MUTATES the doc)
//   node bench/spatial.mjs run      ask the agent the questions and score
//   node bench/spatial.mjs all      both
//
// Requires: Rhino open with listener (8765), agent server (AGENT_PORT, default 8766).

import net from "node:net";
import http from "node:http";

const LISTENER_PORT = 8765;
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 8766);

// Ground truth:
//  - sphereA r=5 @ origin, sphereB r=5 @ [30,0,0]  -> clearance 20
//  - hollow box @ [60,0,0]: outer 20^3, inner 16^3 -> wall thickness 2, hollow
//  - cylinder @ [100,0,0]: r=3, h=47.5             -> tallest, furthest +X
const SETUP_PY = `
import rhinoscriptsyntax as rs
import Rhino
import scriptcontext as sc

# Bench doc is disposable: clear previous bench geometry for idempotent setup.
rs.EnableRedraw(False)
rs.DeleteObjects(rs.AllObjects())

created = []
created.append(rs.AddSphere([0,0,0], 5))
created.append(rs.AddSphere([30,0,0], 5))

# Hollow box as a closed mesh: outer 20^3 shell + inverted 16^3 inner shell.
# Deterministic (no boolean engine), volume = outer - inner automatically.
def boxmesh(cx, cy, cz, s):
    bb = Rhino.Geometry.BoundingBox(
        Rhino.Geometry.Point3d(cx - s/2.0, cy - s/2.0, cz - s/2.0),
        Rhino.Geometry.Point3d(cx + s/2.0, cy + s/2.0, cz + s/2.0))
    box = Rhino.Geometry.Box(bb)
    return Rhino.Geometry.Mesh.CreateFromBox(box, 1, 1, 1)

outer = boxmesh(60, 0, 10, 20.0)
inner = boxmesh(60, 0, 10, 16.0)
inner.Flip(True, True, True)
outer.Append(inner)
if not outer.IsClosed:
    raise RuntimeError("hollow box mesh is not closed")
hollow_id = sc.doc.Objects.AddMesh(outer)
if str(hollow_id) == "00000000-0000-0000-0000-000000000000":
    raise RuntimeError("failed to add hollow box mesh")
created.append(hollow_id)

cyl = rs.AddCylinder(rs.WorldXYPlane(), 47.5, 3)
rs.MoveObject(cyl, [100,0,0])
created.append(cyl)
rs.EnableRedraw(True)

count = len([c for c in created if c])
if count != 4:
    raise RuntimeError("expected 4 bench bodies, created %d" % count)
result = "bench geometry created: 4 bodies"
`;

const TASKS = [
  { id: "sp-tallest", q: "What is the height (Z extent) of the tallest object in the Rhino document? Give a number.", expect: (t) => near(t, 47.5, 1) },
  { id: "sp-clearance", q: "Do the two spheres in the document collide? If not, what is the clearance between them? Give a number.", expect: (t) => near(t, 20, 1) },
  { id: "sp-hollow", q: "Is the box-shaped object near x=60 hollow or solid inside? Answer 'hollow' or 'solid'.", expect: (t) => { const m = t.match(/\b(hollow|solid)\b/i); return !!m && m[1].toLowerCase() === "hollow"; } },
  { id: "sp-wall", q: "What is the wall thickness of the box-shaped shell near x=60? Give a number.", expect: (t) => near(t, 2, 0.4) },
  { id: "sp-furthest", q: "Which object's center is furthest along the +X axis: a sphere, the box shell, or the cylinder?", expect: (t) => /cylinder/i.test(t) },
  { id: "sp-envelope", q: "Would the cylinder fit inside a 10 x 10 x 50 box (axis-aligned)? Answer yes or no.", expect: (t) => /\byes\b/i.test(t) },
];

function near(text, target, tol) {
  const nums = (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  return nums.some((n) => Math.abs(n - target) <= tol);
}

function listenerCall(method, params) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: LISTENER_PORT });
    let buf = "";
    sock.once("error", reject);
    sock.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const msg = JSON.parse(buf.slice(0, i));
      sock.end();
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    sock.once("connect", () =>
      sock.write(JSON.stringify({ id: 1, method, params }) + "\n"));
  });
}

function chat(task) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ message: task.q, label: task.id });
    let answer = "";
    let done = null;
    const req = http.request(
      { host: "127.0.0.1", port: AGENT_PORT, path: "/chat", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            let e; try { e = JSON.parse(line); } catch { continue; }
            if (e.type === "text") answer += e.text + "\n";
            else if (e.type === "done") done = e;
          }
        });
        res.on("end", () => resolve({ answer, done }));
      },
    );
    req.on("error", (e) => resolve({ answer: "", error: e.message }));
    req.end(payload);
  });
}

async function main() {
  const mode = process.argv[2] || "all";
  if (mode === "setup" || mode === "all") {
    console.log("creating ground-truth geometry...");
    const r = await listenerCall("rhino.execute", { code: SETUP_PY });
    console.log(" ", r.result || r.stdout || "done");
  }
  if (mode === "run" || mode === "all") {
    const filter = process.argv[3];
    const tasks = filter ? TASKS.filter((t) => t.id.includes(filter)) : TASKS;
    let pass = 0;
    for (const task of tasks) {
      process.stdout.write(`${task.id}... `);
      const { answer, done, error } = await chat(task);
      if (error) { console.log(`ERROR ${error}`); continue; }
      const ok = task.expect(answer);
      if (ok) pass++;
      console.log(`${ok ? "PASS" : "FAIL"}  ($${(done?.cost ?? 0).toFixed(3)}, ${done?.toolCalls ?? "?"} tools)`);
      if (!ok) console.log(`    answer was: ${answer.trim().slice(0, 300)}`);
    }
    console.log(`\n${pass}/${tasks.length} spatial tasks passed`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
