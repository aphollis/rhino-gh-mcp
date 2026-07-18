// Read-only: dumps every installed component whose name matches the ones our
// templates use, with GUID + category + param names, so templates can pin
// components by GUID (unambiguous) instead of by name. Does NOT touch the
// canvas. Rhino must be open with the listener running.
//
//   node tools/resolve_components.mjs

import net from "node:net";

const PORT = 8765;
const NAMES = ["Circle", "Unit Z", "Extrude", "Rectangle", "Populate 2D", "Voronoi"];

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: PORT });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function main() {
  const sock = await connect();
  let buf = "";
  const handlers = new Map();
  sock.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const h = handlers.get(msg.id);
      if (h) { handlers.delete(msg.id); msg.error ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result); }
    }
  });
  let id = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => { handlers.set(id, { resolve, reject }); sock.write(JSON.stringify({ id: id++, method, params }) + "\n"); });

  await call("gh.launch", {});

  const py = `
import json
import Grasshopper as GH
def safe(v):
    try: return str(v)
    except: return None
names = ${JSON.stringify(NAMES)}
low = [n.lower() for n in names]
out = {}
for p in GH.Instances.ComponentServer.ObjectProxies:
    try:
        if p.Obsolete: continue
    except: pass
    d = p.Desc
    nm = safe(d.Name) or ""
    if nm.lower() not in low: continue
    try: obj = p.CreateInstance()
    except: continue
    cat = ""
    try: cat = (safe(d.Category) or "") + ">" + (safe(d.SubCategory) or "")
    except: pass
    entry = {"name": nm, "guid": safe(p.Guid), "category": cat, "has_params": hasattr(obj, "Params")}
    if hasattr(obj, "Params"):
        entry["in"] = [safe(x.Name) for x in obj.Params.Input]
        entry["out"] = [safe(x.Name) for x in obj.Params.Output]
    out.setdefault(nm, []).append(entry)
result = json.dumps(out)
`;
  const res = await call("rhino.execute", { code: py });
  sock.end();
  const data = JSON.parse(res.result);
  for (const name of NAMES) {
    const cands = data[name] || [];
    console.log(`\n=== ${name} === (${cands.length} match${cands.length === 1 ? "" : "es"})`);
    for (const c of cands) {
      console.log(`  guid=${c.guid}  [${c.category}]  params:${c.has_params}`);
      if (c.in) console.log(`     in:  ${c.in.join(", ")}`);
      if (c.out) console.log(`     out: ${c.out.join(", ")}`);
    }
  }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
