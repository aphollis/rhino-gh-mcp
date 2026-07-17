# rhino-gh-mcp

An MCP server that lets AI agents drive **Rhino 8** and **Grasshopper** live: create
geometry, build parametric Grasshopper definitions ("recipes") on the canvas, wire
components, set sliders, read computed results, bake geometry, and capture viewports.

## Architecture

```
Claude / MCP client  <--stdio-->  Node MCP server (dist/index.js)
                                        |
                                   TCP 127.0.0.1:8765 (JSON lines)
                                        |
                            mcp_listener.py running inside Rhino 8
                            (RhinoCommon + Grasshopper SDK, UI thread)
```

Grasshopper only runs inside Rhino's process, so a small listener script runs in
Rhino and executes every command on Rhino's UI thread. The Node server is what the
MCP client talks to.

## Setup

1. **Build** (already done if `dist/` exists):
   ```
   npm install
   npm run build
   ```

2. **Start the listener in Rhino 8** (each Rhino session):
   - Open Rhino 8, run the `ScriptEditor` command
   - Open `rhino/mcp_listener.py` in the editor and press **Run (F5)**
   - You should see: `rhino-gh-mcp listener running on 127.0.0.1:8765`
   - The listener keeps running in the background; the editor can be closed.
     Re-running the script safely restarts it.

   Tip: to auto-start it, add the file to Rhino's startup scripts
   (Tools > Options > Rhino Script Editor > startup) or create an alias that runs
   `-_ScriptEditor _Run "<path-to-repo>\rhino\mcp_listener.py"`.

3. **Register the MCP server** with your client. For Claude Code:
   ```
   claude mcp add --scope user rhino-grasshopper -- node <path-to-repo>\dist\index.js
   ```
   Or add to any `.mcp.json` / MCP config:
   ```json
   {
     "mcpServers": {
       "rhino-grasshopper": {
         "command": "node",
         "args": ["<path-to-repo>\\dist\\index.js"]
       }
     }
   }
   ```

Set `RHINO_MCP_PORT` (and the `PORT` constant in `mcp_listener.py`) to change the
port from the default 8765.

## Tools

| Tool | Purpose |
| --- | --- |
| `gh_launch` / `gh_status` | Start Grasshopper / check it's running |
| `gh_search_components` | Find components in the installed library |
| `gh_component_info` | Inspect a component's input/output params |
| `gh_build_recipe` | **Build a whole definition in one call** (auto-layout + wiring + solve + error report) |
| `gh_add_component` | Add one component (slider/panel/toggle/valuelist/button or any library component) |
| `gh_connect` / `gh_disconnect` | Wire / unwire params |
| `gh_set_value` | Change slider/panel/toggle/valuelist values |
| `gh_get_canvas` | Full canvas state: objects, wires, values, errors |
| `gh_get_output` | Read computed data from any output |
| `gh_recompute` | Re-solve the definition |
| `gh_new_document` / `gh_save` / `gh_open` | Document management |
| `gh_bake` | Bake output geometry into the Rhino document |
| `gh_delete_components` | Remove canvas objects |
| `rhino_execute_python` | Run arbitrary Python in Rhino (RhinoCommon, rhinoscriptsyntax) |
| `rhino_scene_info` | Layers/objects/units summary |
| `rhino_capture_viewport` | PNG screenshot of a viewport (returned as an image) |

## Example recipe

A single `gh_build_recipe` call like:

```json
{
  "clear": true,
  "components": [
    { "key": "radius", "type": "slider", "min": 1, "max": 20, "value": 5, "nickname": "Radius" },
    { "key": "circle", "type": "Circle" },
    { "key": "extrude", "type": "Extrude" },
    { "key": "dir",    "type": "Unit Z" },
    { "key": "height", "type": "slider", "min": 1, "max": 50, "value": 10, "nickname": "Height" }
  ],
  "connections": [
    { "from": "radius", "to": "circle",  "to_param": "Radius" },
    { "from": "circle", "to": "extrude", "to_param": "Base" },
    { "from": "height", "to": "dir",     "to_param": "Factor" },
    { "from": "dir",    "to": "extrude", "to_param": "Direction" }
  ]
}
```

produces a live parametric circle-extrusion with two sliders, laid out left-to-right,
and reports any per-component errors.

## Requirements

- Rhino 8 (tested with 8.32) — the listener uses the Rhino 8 Script Editor
  (CPython 3); it is also compatible with IronPython 2.7.
- Node.js 18+

## Troubleshooting

- **"Could not reach the Rhino listener"** — Rhino isn't open or the listener
  script isn't running (step 2 above).
- **Timeouts** — Rhino's UI thread is blocked: close any modal dialog, or wait for
  a long solve to finish.
- **Component not found** — use `gh_search_components`; plugin components
  (Kangaroo, Ladybug, ...) are searchable too once installed.
