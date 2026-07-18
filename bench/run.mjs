// Benchmark harness: runs a fixed set of prompts against the agent backend
// and reports turns / tool-calls / tokens / cost per task, plus totals.
// The agent server must be running (node agent/server.mjs) with the Rhino
// listener up. Each task starts a fresh session and clears the canvas first.
//
//   node bench/run.mjs            run all tasks once
//   node bench/run.mjs voronoi    run only tasks whose id matches
//
// Results are appended to agent/metrics.jsonl (tagged with the task id) and a
// summary table is printed. Use this to compare before/after each phase.

import http from "node:http";

const PORT = Number(process.env.AGENT_PORT ?? 8766);

const TASKS = [
  {
    id: "reset",
    prompt: "Start a brand new empty Grasshopper document. Just confirm when done.",
  },
  {
    id: "circle-extrude",
    prompt:
      "In a new Grasshopper document, build: a radius slider (1-20, value 5) into a Circle, " +
      "then extrude that circle upward by a height slider (1-50, value 10). Report component ids.",
  },
  {
    id: "voronoi-panel",
    prompt:
      "In a new Grasshopper document, build a 2D Voronoi pattern: a population of random points " +
      "in a rectangle (count slider), fed into a Voronoi component. Report the Voronoi component id.",
  },
  {
    id: "diagnose",
    prompt:
      "Check the current Grasshopper canvas and tell me, briefly, whether any components have " +
      "errors or warnings, and which.",
  },
];

function chat(task) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ message: task.prompt, label: task.id });
    const started = Date.now();
    let done = null;
    let toolCalls = 0;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/chat", method: "POST",
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
            if (e.type === "tool") toolCalls++;
            else if (e.type === "done") done = e;
            else if (e.type === "error") done = { error: e.message };
          }
        });
        res.on("end", () =>
          resolve({ id: task.id, wallMs: Date.now() - started, toolCalls, ...done }));
      },
    );
    req.on("error", (e) => resolve({ id: task.id, error: e.message }));
    req.end(payload);
  });
}

async function main() {
  const filter = process.argv[2];
  const tasks = filter ? TASKS.filter((t) => t.id.includes(filter)) : TASKS;
  const rows = [];
  for (const task of tasks) {
    process.stderr.write(`running ${task.id}... `);
    const r = await chat(task);
    process.stderr.write(
      r.error ? `ERROR ${r.error}\n` : `${r.turns}t ${r.toolCalls}tc $${(r.cost ?? 0).toFixed(3)}\n`);
    rows.push(r);
  }

  const cell = (s, w, right = true) =>
    right ? String(s).padStart(w) : String(s).padEnd(w);
  const line = (a, b, c, d, e) =>
    console.log(cell(a, 16, false) + cell(b, 7) + cell(c, 7) + cell(d, 11) + cell(e, 9));

  console.log();
  line("task", "turns", "tools", "cost", "wall(s)");
  let cost = 0, tc = 0, turns = 0;
  for (const r of rows) {
    if (r.error) { console.log(cell(r.id, 16, false) + "  ERROR: " + r.error); continue; }
    cost += r.cost ?? 0; tc += r.toolCalls; turns += r.turns ?? 0;
    line(r.id, r.turns ?? "-", r.toolCalls,
      "$" + (r.cost ?? 0).toFixed(3), ((r.wallMs ?? 0) / 1000).toFixed(1));
  }
  line("TOTAL", turns, tc, "$" + cost.toFixed(3), "");
}

main();
