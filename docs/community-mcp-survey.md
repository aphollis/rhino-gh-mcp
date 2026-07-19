# Community & Official CAD MCP Server Survey

**Date:** 2026-07-19 · **Purpose:** inform the M5 Fusion 360 adapter
(RFD-001 §9) and competitive positioning of rhino-gh-mcp.
**Method:** web search + repo README fetches. Stars/activity figures are
**as-of-fetch snapshots** and are approximate; where a claim could not be
verified it is flagged. Deep code review was not performed — descriptions
reflect each project's own documentation.

---

## 1. Fusion 360

### 1.1 Autodesk official efforts (three distinct things)

Autodesk currently has **three** MCP-branded artifacts. They are frequently
conflated in coverage; keep them straight:

#### a) Fusion MCP (in-product local server / Claude connector)

- **What:** The official MCP server that ships **inside Fusion** itself.
  Enabled via *Preferences → General → API → "Fusion MCP Server"* checkbox,
  which also displays the local port. Announced 2026-04-28 alongside
  Anthropic's "Claude for Creative Work" launch (one of nine connectors,
  including Blender and Adobe CC).
- **Architecture:** Local HTTP MCP server bound to the machine running
  Fusion; requires a live Fusion session and a Fusion subscription. Autodesk
  and PromptArmor both emphasize "the MCP server runs on your machine" —
  design data stays local. Compatible with Claude Desktop, Cursor, or "any
  MCP-capable HTTP client" (per engineering.com). Closed source — no public
  repo for the in-product server.
- **Tool surface (as documented publicly):** create/modify/query design
  geometry and features; the official blog framing is notably
  **API-script-centric** rather than a large named-tool catalog: "anything
  the Fusion API can read is fair game: bounding boxes, mass and volume,
  center of gravity, material assignments, timeline features and parameters,
  sketch geometry, joint limits, user-defined expressions." Highlighted use
  cases: batch rename, bulk material swap, parameter updates, batch export
  (STL/STEP/F3D), screenshots/reports, scripting simple parts. PromptArmor
  notes "tool list not yet catalogued."
- **Positioning:** Autodesk frames it as "an early step"; explicitly *not*
  pitched as blank-sheet design automation. Third-party commentary (CoLab)
  stresses it can't handle tolerance stacks, manufacturing constraints, or
  constraint-solver reasoning. Roadmap: more MCP servers coming (Revit,
  Autodesk documentation).

#### b) Fusion Data MCP Server (cloud/remote)

- **What:** A separate, **cloud-hosted remote MCP server** for Fusion's data
  management layer (hubs, projects, folders, items, permissions, team
  access). Does **not** require Fusion to be running.
- **Relevance to us:** essentially none for geometry — it is a PDM/admin
  surface, not a modeling surface. Its significance is positioning:
  Autodesk splits *modeling* (local, in-app) from *data* (remote, cloud) —
  the same split our architecture already implies (listener in-app, heavy
  compute out-of-app).

#### c) AutodeskFusion360/FusionMCPSample (open reference implementation)

- **Repo:** https://github.com/AutodeskFusion360/FusionMCPSample —
  "Reference implementation of an MCP server to run Fusion API scripts."
- **License:** **MIT**. Python. ~17 stars, 5 commits, last updated
  ~Jan 2026.
- **Architecture:** a Fusion **add-in** exposing MCP-compatible **HTTP**
  endpoints from a threaded HTTP server, with a **TaskManager** that
  marshals work from background HTTP handler threads onto Fusion's main
  thread via **custom events**.
- **Tools (3):** `execute_api_script` (arbitrary Fusion API Python),
  `get_screenshot` (multiple orientations), `get_api_documentation` (search
  API docs). That's the whole surface — the official reference bet is
  "give the model a code escape hatch + eyes + docs," not a big named-tool
  catalog.
- **Why it matters:** this is the **borrowable, MIT-licensed distillation of
  how Autodesk itself thinks an in-Fusion MCP add-in should be built** —
  add-in bootstrap, threaded HTTP server, main-thread task marshalling.

### 1.2 Community Fusion servers

#### Joe-Spencer/fusion-mcp-server

- **Repo:** https://github.com/Joe-Spencer/fusion-mcp-server ·
  **License: GPL-3.0** · ~47 stars, only ~7 commits (early-stage, low
  activity).
- **Architecture:** pure-Python **add-in that hosts the MCP server itself**
  — MCP over **HTTP SSE at `127.0.0.1:3000/sse`**, with a **file-polling
  fallback** (`mcp_comm` directory) for robustness. Runs a background
  thread inside Fusion to stay responsive.
- **Tools:** thin — resources for document info / design structure /
  parameters; tools for `message_box`, `create_new_sketch`,
  `create_parameter`; two prompts. No screenshot, no measurement, no code
  execution documented.
- **Take:** historically notable (it's the one Gemini's sketch cited), but
  the thinnest of the serious Fusion servers. **GPL-3.0 — do not copy
  code** into our MIT-side work.

#### faust-machines/fusion360-mcp-server — *the most complete community surface*

- **Repo:** https://github.com/faust-machines/fusion360-mcp-server ·
  **License: MIT** · ~55 stars · "Beta — under active development,"
  ~11 commits. On PyPI (`uvx fusion360-mcp-server --mode socket`).
- **Architecture:** `MCP client ←stdio→ Python server ←TCP :9876→ Fusion
  add-in ←CustomEvent→ main thread`. Same split as our Rhino design (Node
  ↔ TCP ↔ in-app listener), and the same port blender-mcp uses.
- **Tools (~84):** the largest catalog found — sketches + primitives;
  extrude/revolve/sweep/loft/fillet/chamfer/shell/patterns/threads/draft/
  split; booleans; sheet metal; assemblies + all joint types; **CAM/
  manufacturing (setups, toolpaths, G-code post)**; STL/STEP/F3D export;
  arbitrary-Python escape hatch; undo with design-type safety guards.
- **Spatial/measurement:** yes, as **kernel passthroughs** — distance and
  angle measurement between entities, physical properties (mass, volume,
  center of mass), **interference detection**, **section-plane analysis**.
- **Notably clever:** MCP tool annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`) for client-side permissioning; a
  `--mode mock` for testing without Fusion; explicit "all measurements in
  centimeters (Fusion's internal unit)" — confirming the RFD-001 §8b unit
  caveat. Single-operation-per-call restriction to avoid crashes;
  30-second command timeout. No screenshot tool documented.

#### frankhommers/autodesk-fusion-mcp

- **Repo:** https://github.com/frankhommers/autodesk-fusion-mcp ·
  **MIT** · ~6 stars · v1.0.0 released 2026-03-22. Community (despite the
  name — not Autodesk).
- **Architecture:** the cleanest transport of the bunch — a pure-stdlib
  Python add-in speaking **native MCP Streamable HTTP (spec 2025-03-26) at
  `http://127.0.0.1:8765/mcp`**; no sidecar process at all. Requests are
  relayed to the main thread via a Custom Event / work-queue dispatcher.
- **Tools (11):** `call_autodesk_api`, `execute_python`, `capture_viewport`,
  `get_active_selection`, `fetch_api_documentation`, script save/load/
  list/delete. No dedicated measurement tools — generic-API-access
  philosophy, like FusionMCPSample.

#### prim-design/fusion-mcp

- **Repo:** https://github.com/prim-design/fusion-mcp · **MIT** · ~1 star,
  14 commits (minimal traction, but a serious surface).
- **Architecture:** stdio Python server ↔ TCP ↔ add-in, CustomEvent
  main-thread execution (same pattern again).
- **Tools (51):** full sketch set incl. slots/splines; extrude/revolve/
  sweep/loft; fillet/chamfer/shell/draft; patterns/mirror; booleans;
  components; **all 7 Fusion joint types with limits + drive**; rigid
  groups; **inspection: design info, body inspection, `measure`,
  interference checking, fit view**; STL/STEP/3MF; Python escape hatch;
  **screenshot with preset views (front/back/top/bottom/left/right/iso) or
  custom camera**.

#### ndoo/fusion360-mcp-bridge

- **Repo:** https://github.com/ndoo/fusion360-mcp-bridge · **MIT** ·
  ~16 stars.
- **Architecture:** Python MCP server ↔ **HTTP on `127.0.0.1:7654` with
  Bearer-token auth** (auto-generated secret) ↔ add-in; CustomEvent
  marshalling with `threading.Event` blocking until the main-thread result
  returns — the clearest documented statement of the threading contract:
  "Fusion's Python API must only be called on the main thread."
- **Tools (2, deliberately minimal):** `fusion_execute` (arbitrary Python,
  full `adsk.*`) and `fusion_screenshot` (base64 PNG). All Fusion API
  knowledge lives in a CLAUDE.md the client reads — i.e., prompt-side
  knowledge instead of tool-side surface.

#### AuraFriday/Fusion-360-MCP-Server

- **Repo:** https://github.com/AuraFriday/Fusion-360-MCP-Server ·
  **License: proprietary** ("see LICENSE") · ~108 stars · last activity
  ~Jan 2026.
- **Architecture:** Python add-in making a **reverse connection to a local
  "MCP-Link" server over SSE/JSON-RPC**. Auto-updating with
  cryptographically verified updates.
- **Tools:** execute-Python-centric with pre-injected `app`, `ui`, `design`,
  `rootComponent`; cross-call context via `store_as`; mass/volume analysis;
  API introspection plus online docs plus a best-practices guide (three-tier
  documentation); claims full CAM module access.
- **Take:** feature-rich but **closed license — observe only, never copy.**

#### ArchimedesCrypto/fusion360-mcp-server

- **Repo:** https://github.com/ArchimedesCrypto/fusion360-mcp-server ·
  MIT · ~80 stars but ~2 visible commits (dormant).
- **Architecture:** **script generation** — it emits Python the user must
  **manually paste into Fusion's Script Editor**. Not a live bridge.
  ~15 tools (sketch/extrude/fillet/boolean/export). Mostly a cautionary
  tale: stars ≠ working automation.

#### Long tail (verified to exist; not deeply reviewed)

- **Joelalbon/Fusion-MCP-Server** — JSON-socket client/server + add-in;
  remote command execution and model data retrieval.
- **perkovicluka/fusion-360-mcp-server** — local MCP server for Fusion.
- **sockcymbal/autodesk-fusion-mcp-python** — the odd one out: cloud-side
  via **Autodesk Platform Services + OAuth**, one tool (parametric cube);
  prototype (per Snyk survey).
- **Misterbra/fusion360-claude-ultimate**, **jaskirat1616/fusion360-mcp**,
  **justusbraitinger/fusionmcp** — further variations; not assessed.

---

## 2. Rhino / Grasshopper

### 2.1 jingcheng-chen/rhinomcp — *the flagship community Rhino server*

- **Repo:** https://github.com/jingcheng-chen/rhinomcp · **MIT** ·
  ~904 stars · release 0.3.2 (2026-06-28) — actively maintained. Installs
  via **Rhino Package Manager** (`rhinomcp`) + `uv`-launched Python server.
  Rhino 8, Windows/macOS.
- **Architecture:** three tiers — Python FastMCP server (stdio) ↔ **TCP
  `127.0.0.1:1999`** ↔ **C# RhinoCommon plugin** running the listener
  inside Rhino and executing on the main thread. Ships **JSON Schema wire
  contracts** in a `contracts/` directory to keep both halves in sync
  (worth imitating).
- **Tools:** broad primitive creation (points→surfaces, batch);
  move/rotate/scale/recolor/rename/delete; booleans; loft/extrude/sweep/
  offset/pipe; curve project/intersect/split; **query/measure: document
  summary, object info, length/area/volume/bounding box, filtered selection
  with AND/OR logic**; viewport capture; attribute read/write; **three
  execute-code escape hatches** (native Rhino commands, RhinoScript-Python,
  RhinoCommon C#).
- **Grasshopper:** per current README, component search/inspection, canvas
  building and wiring, parameter driving, solution solving, and batched
  graph construction. (Earlier versions had little GH support; this
  appears to have landed during 2026 — treat the exact GH tool list as
  needing hands-on verification.)
- **Security note:** unauthenticated loopback TCP; the execute tools are a
  wide-open local surface.
- **Take: this is our most direct competitor.** Same plugin+TCP shape as
  ours. What it does *not* have (per docs): stable short handles, idempotent
  keyed builds, semantic canvas diff, server-side validation contracts,
  templates/recipes, token-efficiency instrumentation, or any derived
  spatial layer (voxels/sections/relations/neutral multiview) — its
  measurement is per-object kernel passthrough only, and there is no
  measurement of **unbaked GH volatile geometry**.

### 2.2 Other Rhino servers

- **SerjoschDuering/rhino-mcp** — https://github.com/SerjoschDuering/rhino-mcp
  · MIT · ~66 stars · forked from blender-mcp. Python socket server
  **inside Rhino on :9876**; separate **HTTP servers for Grasshopper**
  (non-blocking). Tools: scene inspection, object creation/manipulation,
  layers, screenshots, arbitrary Python in Rhino; GH-side: generate/manage
  GHPython script components, link external code files, read component
  graph/errors; **Replicate/Stable-Diffusion rendering integration**
  (novel). No structured measurement layer.
- **reer-ide/rhino_mcp** — https://github.com/reer-ide/rhino_mcp · MIT ·
  ~23 stars · v0.1.10 (2025-07-31). Python-only: a `rhino_script.py` run
  inside Rhino opens a socket server; stdio MCP server plus optional SSE on
  `127.0.0.1:8080`. Scene inspection w/ metadata, layers, viewport capture
  **with annotations**, arbitrary Python, RhinoScriptSyntax doc lookup. GH
  integration explicitly "under development and not fully usable yet."
- **4kk11/RhinoMCPServer** — https://github.com/4kk11/RhinoMCPServer · MIT
  · ~13 stars, 136 commits. Architecturally interesting: the **MCP server
  is embedded in the Rhino plugin itself** (official C# MCP SDK, Streamable
  HTTP at `localhost:{port}/mcp`, isolated `AssemblyLoadContext`), no
  sidecar. **Dynamic tool plugins** (drop DLLs in a folder). Tools include
  geometry create/modify, dimensions, layers, `get_geometry_info`,
  **`raycast_from_screen`** (viewport pick-ray intersection — a genuinely
  clever perception primitive), viewport capture, and GH canvas tools
  (components, wiring, sliders, runtime messages, solution status, file
  load/save).
- **Long tail:** pedrocortesark/RhinoMcpServer (C#/.NET 8 stdio, headless
  option, 0 stars, read-only doc/geometry extraction, no license file);
  a01110946/RhinoMCP; always-tinkering/rhinoMcpServer;
  GreatpythonGPT/rhino-new-mcp — all low-activity/low-star; not deeply
  reviewed.

### 2.3 Grasshopper-specific servers

- **alfredatnycu/grasshopper-mcp** — https://github.com/alfredatnycu/grasshopper-mcp
  · MIT · ~91 stars. C# **GH_MCP.gha component hosts a TCP server on
  :8080**; Python bridge on PyPI. Creates/connects components from natural
  language; **JSON component knowledge base** (component metadata,
  connection rules, "intent" patterns that expand a description into a
  multi-component pattern) + a prompt template. No measurement/spatial
  tools documented. Single contributor. Closest analog to our recipe/
  template layer, but knowledge-base-driven rather than server-validated.
- **veoery/GH_mcp_server** — https://github.com/veoery/GH_mcp_server · MIT
  · ~31 stars, 12 commits, "still under construction." Python; drives
  Rhino via a CodeListener-style connection; generates GHPython scripts to
  file; reads .3dm files. Thin.
- **dongwoosuk/grasshopper-mcp** — https://github.com/dongwoosuk/grasshopper-mcp
  · MIT · ~15 stars · beta v0.1.0. Python MCP ↔ TCP ↔ Rhino listener;
  500+-component library; **ML canvas-layout optimization** (KNN position
  prediction, wire-crossing minimization, DBSCAN/K-means grouping),
  performance-impact prediction, anti-pattern detection (redundant
  flattens, serial booleans). Claims layout optimization is unique — for
  canvas *aesthetics* that's plausible. No spatial geometry reasoning.

---

## 3. Adjacent reference points

### 3.1 blender-mcp — the pattern-setter

- **Repo:** https://github.com/ahujasid/blender-mcp · **MIT** ·
  **~24.5k stars** (the category anchor by an order of magnitude).
- **Architecture:** the template everyone (including us and rhinomcp)
  follows — Blender addon runs a **JSON-over-TCP socket server (default
  :9876)** inside the app; separate Python MCP server (stdio) bridges to
  the client.
- **Tools:** create/delete/modify objects; materials; **scene/object
  query**; viewport screenshot; **arbitrary Python execution**; plus asset
  integrations: **PolyHaven** (textures/HDRIs/models), **Hyper3D Rodin**
  and **Hunyuan3D** (AI 3D generation), **Sketchfab** (search/download).
- **Spatial:** nothing beyond object-info queries and screenshots. Docs
  explicitly coach breaking complex ops into steps.
- **Lesson:** the asset-integration layer, not geometric intelligence, is
  what drove mass adoption; and user-consent telemetry is handled
  gracefully.

### 3.2 FreeCAD

- **neka-nat/freecad-mcp** — https://github.com/neka-nat/freecad-mcp · MIT
  · **~1.4k stars** (largest CAD-proper MCP). Workbench addon runs an
  **XML-RPC server**; MCP server connects over the network (remote hosts
  supported with IP allowlisting). Tools: document/object CRUD, parts
  library, `execute_code`, `get_view` screenshots, **`run_fem_analysis`
  (CalculiX — returns max von Mises stress, displacement)**. Notable:
  **"text-only feedback mode to reduce token usage"** — the only other
  project found that treats tokens as a budget.
- **theosib/FreeCAD-MCP-Server** — https://github.com/theosib/FreeCAD-MCP-Server
  · **LGPL-2.1-or-later** · ~13 stars, v0.1.0 (2026-03). Addon hosts
  threaded TCP :9876 with a **QTimer-polled work queue** for main-thread
  dispatch. The standout is its **inspection depth**: full feature-tree
  graph with dependencies and validity, `analyze_shape` (face
  classification — plane/cylinder/cone —, edge details, bbox, volume),
  **`get_sketch_diagnostics` (constraint health, DOF, conflicts,
  redundancies)**, recompute before/after error diffs, hot-reload of
  handler code. The deepest *structural* (not spatial) introspection in
  this survey.
- Others: contextform/freecad-mcp, bonninr/freecad_mcp (2 tools:
  command+context, exec), sandraschi/freecad-mcp (CFD-flavored),
  lucygoodchild/freecad-mcp-server — not deeply reviewed.

### 3.3 SolidWorks

- **alisamsam/solidworks-mcp** — https://github.com/alisamsam/solidworks-mcp
  · MIT · ~67 stars. Python + **Windows COM automation** (no add-in —
  SolidWorks' COM API is callable out-of-process, so no socket bridge is
  needed). 22 tools: document/sketch/feature creation, fillets/chamfers,
  queries (documents, features, version), unit conversion, Python exec.
  No screenshot, no measurement tools.
- **eyfel/mcp-server-solidworks** — https://github.com/eyfel/mcp-server-solidworks
  · ~14 stars · COM + PythonNET with version-specific C# adapters
  (2021–2025). "Context stream" framing; not deeply reviewed.

### 3.4 Onshape (cloud REST — no in-app bridge needed)

- **jarvis-onshape-mcp (ReshefElisha)** — https://github.com/ReshefElisha/jarvis-onshape-mcp
  · MIT (forked from hedless/onshape-mcp) · ~144 stars · v1.2.0
  (2026-04). Python MCP over the **Onshape REST API (HMAC auth)**; ~60
  tools. **The most interesting project in this survey for us:**
  - **Truth-telling:** every op returns structured status + feature IDs +
    error + *actionable next-step hints* (their version of our Phase-2
    "terse, self-correcting returns").
  - **Vision-decomposition skill:** pre-build structured analysis of a
    reference image into a feature tree the user confirms before any
    geometry is made.
  - **Multi-view PNG renders** (front/top/right/iso) with cropping and
    **side-by-side visual diffs** against cached reference images —
    the closest thing found to our `space_views`, though produced by
    Onshape's cloud renderer, not a neutral raycaster.
  - **Spatial measurement:** bounding boxes, mass properties, face
    coordinate systems, **interference checking**; deterministic entity
    IDs with outward normals.
- **hedless/onshape-mcp** (Python; sketches, features, assemblies,
  variables, FeatureScript eval, export), **BLamy/onshape-mcp**
  (TypeScript, 18 tools incl. bounding-box calc), **altendky/onshape-mcp**
  (Rust/TS binary), **clarsbyte/onshape-mcp** (fork) — the upstream
  family; not deeply reviewed.

### 3.5 AutoCAD (for completeness, via Snyk's survey)

daobataotie/CAD-MCP (~98 stars, COM, 12 tools, also GstarCAD/ZWCAD),
zh19980811/Easy-MCP-AutoCad (~64 stars, COM+SQLite),
puran-water/autocad-mcp (~59 stars, AutoLISP generation, 35+ P&ID tools).
All COM/script-generation approaches; none spatially interesting.

---

## 4. Comparison table

| Server | App | Stars* | License | Transport (server↔app) | In-app half | Exec escape hatch | Screenshot | Measurement/spatial |
|---|---|---|---|---|---|---|---|---|
| **Autodesk Fusion MCP (official)** | Fusion | n/a (closed) | proprietary | local HTTP (in-product) | built-in | via API scripting | yes | kernel reads (bbox, mass, COG) via API |
| **FusionMCPSample (official ref)** | Fusion | 17 | MIT | HTTP | add-in, custom-event TaskManager | yes (core design) | yes | via scripts only |
| Joe-Spencer/fusion-mcp-server | Fusion | 47 | **GPL-3.0** | SSE :3000 + file polling | add-in hosts MCP | no | no | no |
| faust-machines/fusion360-mcp-server | Fusion | 55 | MIT | stdio→TCP :9876 | add-in, CustomEvent | yes | no | **dist/angle, mass props, interference, sections** |
| frankhommers/autodesk-fusion-mcp | Fusion | 6 | MIT | Streamable HTTP :8765 | add-in hosts MCP | yes | yes | no |
| prim-design/fusion-mcp | Fusion | 1 | MIT | stdio→TCP | add-in, CustomEvent | yes | yes (preset views) | measure + interference |
| ndoo/fusion360-mcp-bridge | Fusion | 16 | MIT | stdio→HTTP :7654 + Bearer | add-in, CustomEvent+Event | yes (core design) | yes | via scripts only |
| AuraFriday/Fusion-360-MCP-Server | Fusion | 108 | **proprietary** | SSE/JSON-RPC reverse-connect | add-in | yes | no | mass/volume via API |
| ArchimedesCrypto | Fusion | 80 | MIT | script generation (manual paste) | none | n/a | no | no |
| **jingcheng-chen/rhinomcp** | Rhino+GH | 904 | MIT | stdio→TCP :1999 | C# plugin | yes ×3 | yes | length/area/volume/bbox per object |
| SerjoschDuering/rhino-mcp | Rhino+GH | 66 | MIT | socket :9876 + GH HTTP | Python script | yes | yes | object info only |
| reer-ide/rhino_mcp | Rhino | 23 | MIT | socket (+SSE :8080) | Python script | yes | yes (annotated) | object info only |
| 4kk11/RhinoMCPServer | Rhino+GH | 13 | MIT | Streamable HTTP (in-plugin) | C# plugin hosts MCP | GH file ops | yes + **raycast_from_screen** | geometry info, vol/area |
| alfredatnycu/grasshopper-mcp | GH | 91 | MIT | Python bridge→TCP :8080 | C# GH component | no | no | no |
| dongwoosuk/grasshopper-mcp | GH | 15 | MIT | TCP→Rhino listener | script | yes | no | no (canvas ML only) |
| **ahujasid/blender-mcp** | Blender | ~24.5k | MIT | stdio→JSON/TCP :9876 | addon | yes | yes | scene info only |
| neka-nat/freecad-mcp | FreeCAD | ~1.4k | MIT | XML-RPC | workbench addon | yes | yes | FEM results |
| theosib/FreeCAD-MCP-Server | FreeCAD | 13 | **LGPL-2.1+** | stdio→TCP :9876 JSON-RPC | addon, QTimer queue | yes | yes | **topology analysis, sketch DOF/constraint diagnostics** |
| alisamsam/solidworks-mcp | SolidWorks | 67 | MIT | COM (out-of-process) | none needed | yes | no | no |
| **jarvis-onshape-mcp** | Onshape | 144 | MIT | REST (cloud) | none needed | FeatureScript | **multi-view renders + visual diff** | **bbox, mass props, interference, face CS** |

\* Stars as reported by README fetches July 2026; approximate.

---

## 5. Synthesis

### 5.1 What the M5 Fusion adapter should reuse or copy

1. **The threading pattern is unanimous — adopt it verbatim.** Every
   working Fusion bridge (official FusionMCPSample, faust-machines,
   prim-design, ndoo, frankhommers) uses the same mechanism: background
   listener thread receives the request → fires a **Fusion CustomEvent** →
   handler runs on the UI thread → background thread blocks on a
   `threading.Event` until the result lands. FusionMCPSample's
   `TaskManager` is the MIT-licensed canonical version; ndoo's README has
   the clearest write-up. This maps 1:1 onto our Rhino listener's
   main-thread marshalling, so `bodies()`/`tessellate()` port cleanly.
2. **Add-in bootstrap:** plain Python add-in in
   `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\` (macOS:
   `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/`),
   run via Shift+S → Add-Ins. frankhommers proves a **zero-dependency,
   stdlib-only** add-in is sufficient — important because Fusion's
   embedded Python environment makes dependency management painful.
   faust-machines' symlink install script is a nice dev-loop touch.
3. **Transport:** our cleanest fit is the faust-machines/prim shape —
   keep our Node MCP server, add a **TCP loopback listener in the Fusion
   add-in** speaking the same framed-JSON protocol as the Rhino listener
   (adapter = new endpoint, zero core changes). Avoid colliding with
   squatted ports (9876 blender/faust, 7654 ndoo, 8765 frankhommers,
   3000 Joe-Spencer, 1999 rhinomcp) — and detect/handle the **official
   in-product Fusion MCP server's port** (user-visible in Preferences)
   since users may run both.
4. **Copy ndoo's Bearer-token auth.** We'd be the second CAD bridge with
   any authentication at all; every other bridge (including rhinomcp) is
   an unauthenticated local RCE endpoint.
5. **Units/axis:** faust-machines confirms in practice what RFD-001 §8b
   states — the Fusion API is **always centimeters** internally and Y-up;
   convert at the adapter boundary.
6. **Positioning vs. official Autodesk MCP:** the official server is
   script-execution + screenshots + doc search over a live session (and a
   separate cloud data server). It does **not** ship a structured spatial
   query layer. Our adapter doesn't compete with it — we sit *above* the
   same API surface with a deterministic spatial core the official offering
   lacks. If Autodesk later exposes richer named tools, our adapter surface
   (two primitives) is small enough to re-host on top of theirs.
7. **Steal for robustness:** faust-machines' single-operation-per-call +
   timeout discipline; its `--mode mock` (we could add a mock adapter for
   CI of the spatial core against canned meshes — we effectively have this
   via synthetic tests); tool annotations (`readOnlyHint` etc.) on our
   tool definitions.

### 5.2 Does anyone do spatial understanding beyond screenshots?

**The strong claim ("none do anything") is refuted; the claim that matters
survives.** Precisely:

- **Several servers expose kernel measurement passthroughs:**
  faust-machines (distance/angle, mass props, interference, section-plane
  analysis), prim-design (measure, interference), jarvis-onshape (bbox,
  mass properties, interference, face coordinate systems),
  jingcheng-rhinomcp (length/area/volume/bbox per object), theosib-FreeCAD
  (topology classification, sketch constraint/DOF diagnostics — structural,
  not spatial), neka-nat (FEM results).
- **Nobody has a derived spatial-reasoning layer.** No project found
  computes anything the host kernel doesn't hand it directly: **no voxel
  occupancy, no containment/inside-ness tests, no clearance/relation
  graphs over object pairs, no wall-thickness extraction, no
  platform-neutral mesh core, no BVH, no off-app computation at all** —
  and none can measure **unbaked Grasshopper volatile geometry**. The
  closest neighbors are jarvis-onshape's multi-view renders + visual
  diffing (image channel, cloud-rendered, still "look and guess") and
  faust/prim's interference checks (kernel booleans, single-pair,
  no clearance distance semantics).
- Conclusion: our RFD-001 core — symbolic spatial truth computed in a
  neutral core from two adapter primitives — **has no prior art in this
  ecosystem**. The defensible novelty is the *derived* layer (voxels,
  sections with thickness, relations with clearance, neutral ortho
  raycasts, `space_fit`), not the existence of a "measure" tool, which is
  now table stakes.

### 5.3 Competitive positioning

**What we have that no surveyed server has:**

- The spatial core itself (§5.2) and its benchmark-gated methodology.
- Measurement of **GH volatile geometry via handles without baking**.
- The token-efficiency program as a system: cached component reference,
  stable short handles, idempotent keyed builds, semantic canvas diff,
  terse self-correcting error returns, metrics baseline. (Only neka-nat's
  "text-only feedback mode" and jarvis's hint-bearing returns gesture at
  this.)
- Server-side validation ("healthy"/problem list) of GH graphs.
- Template/recipe layer with exposed parameters (alfredatnycu's intent
  patterns are the nearest analog, client-side and unvalidated).

**What they have that we lack — candidates worth stealing:**

1. **jarvis-onshape's vision-decomposition skill** — turn a reference
   image into a confirmable build plan before building. Natural fit atop
   our recipe system ("image → proposed recipe → user confirms → build").
2. **Visual diff against reference** (jarvis) — pairs beautifully with our
   deterministic `space_views` renderer: same camera, pixel/region diff,
   "did the change do what you think" verification loop.
3. **`raycast_from_screen`** (4kk11) — "what object is at this pixel"
   bridges the image channel back to symbolic IDs; trivial with our BVH
   (we already have the raycaster; expose a screen-space pick).
4. **Tool annotations** (`readOnlyHint`/`destructiveHint`) —
   faust-machines; cheap, spec-conformant, improves client UX.
5. **Asset integrations** (blender-mcp's PolyHaven/Sketchfab) — the
   single biggest adoption lever observed; a Rhino analog could be
   McNeel package/content or a curated block/material library.
6. **Sketch-constraint-style diagnostics** (theosib) — our GH runtime
   diagnostics are the analog; consider extending toward "why is this
   definition unhealthy" explanations (DOF-style reasoning for GH data
   trees, e.g. mismatch/graft anomalies).
7. **Wire-contract files** (jingcheng's `contracts/` JSON schemas) — we
   informally have this; formalizing the listener protocol as checked-in
   schemas would harden the two-repo/two-language boundary before a Fusion
   adapter multiplies it.

**Threat assessment:** jingcheng-chen/rhinomcp owns Rhino MCP mindshare
(~900 stars, Package Manager distribution, active releases) with a
capable generalist surface. Our differentiation is depth (spatial
reasoning, efficiency, validated GH builds), not breadth — don't compete
on primitive-creation tool count. blender-mcp shows distribution +
integrations beat sophistication for stars; FusionMCPSample + the official
in-product MCP show Autodesk betting on "escape hatch + eyes + docs,"
which leaves the structured-spatial niche open.

### 5.4 Licensing considerations for borrowed add-in code

- **Safe to copy/adapt (MIT):** AutodeskFusion360/FusionMCPSample (the
  TaskManager/custom-event pattern — best source), faust-machines,
  frankhommers, prim-design, ndoo, jingcheng-chen/rhinomcp, blender-mcp,
  jarvis-onshape-mcp, alfredatnycu. Attribution: retain copyright notice
  per MIT if code (not just the idea) is copied.
- **Do NOT copy code:** Joe-Spencer/fusion-mcp-server (**GPL-3.0** —
  copying would obligate GPL on our distribution), AuraFriday
  (**proprietary**). Reading for ideas is fine; the CustomEvent pattern
  itself is standard Fusion API practice documented by Autodesk and not
  protectable.
- **Careful:** theosib/FreeCAD-MCP-Server is **LGPL-2.1+** — fine to link,
  messy to copy into MIT code; pedrocortesark has **no license file**
  (default all-rights-reserved — do not copy).
- The threading/bootstrap *patterns* appear in Autodesk's own MIT sample,
  so basing our add-in skeleton on FusionMCPSample is the cleanest
  provenance story.

---

## 6. Sources

**Autodesk official**
- https://www.autodesk.com/products/fusion-360/blog/introducing-the-fusion-mcp-opening-fusion-to-ai-powered-workflows/ (403 to fetcher; content via search excerpts)
- https://www.autodesk.com/products/fusion-360/blog/introducing-the-autodesk-fusion-data-mcp-server/
- https://www.autodesk.com/products/fusion-360/blog/build-your-own-fusion-add-ins-with-the-fusion-mcp/ (via search excerpts)
- https://www.autodesk.com/products/fusion-360/blog/how-to-improve-your-fusion-workflow-with-the-claude-desktop-connector/ (via search excerpts)
- https://aps.autodesk.com/blog/bringing-fusion-claude-creative-work
- https://www.autodesk.com/solutions/autodesk-ai/autodesk-mcp-servers
- https://forums.autodesk.com/t5/fusion-api-and-scripts-forum/driving-fusion-via-ai-using-mcp-server-add-in-announcement/td-p/13881165 (403 to fetcher)
- https://github.com/AutodeskFusion360/FusionMCPSample

**Fusion community**
- https://github.com/Joe-Spencer/fusion-mcp-server
- https://github.com/faust-machines/fusion360-mcp-server
- https://github.com/frankhommers/autodesk-fusion-mcp
- https://github.com/prim-design/fusion-mcp
- https://github.com/ndoo/fusion360-mcp-bridge
- https://github.com/AuraFriday/Fusion-360-MCP-Server
- https://github.com/ArchimedesCrypto/fusion360-mcp-server
- https://github.com/Joelalbon/Fusion-MCP-Server · https://github.com/perkovicluka/fusion-360-mcp-server · https://github.com/Misterbra/fusion360-claude-ultimate · https://github.com/jaskirat1616/fusion360-mcp

**Rhino / Grasshopper**
- https://github.com/jingcheng-chen/rhinomcp
- https://github.com/SerjoschDuering/rhino-mcp
- https://github.com/reer-ide/rhino_mcp
- https://github.com/4kk11/RhinoMCPServer
- https://github.com/pedrocortesark/RhinoMcpServer
- https://github.com/a01110946/RhinoMCP · https://github.com/always-tinkering/rhinoMcpServer · https://github.com/GreatpythonGPT/rhino-new-mcp
- https://github.com/alfredatnycu/grasshopper-mcp
- https://github.com/veoery/GH_mcp_server
- https://github.com/dongwoosuk/grasshopper-mcp

**Adjacent**
- https://github.com/ahujasid/blender-mcp
- https://github.com/neka-nat/freecad-mcp
- https://github.com/theosib/FreeCAD-MCP-Server
- https://github.com/contextform/freecad-mcp · https://github.com/bonninr (freecad_mcp) · https://github.com/sandraschi/freecad-mcp · https://github.com/lucygoodchild/freecad-mcp-server
- https://github.com/alisamsam/solidworks-mcp
- https://github.com/eyfel/mcp-server-solidworks
- https://github.com/ReshefElisha/jarvis-onshape-mcp
- https://github.com/hedless/onshape-mcp · https://github.com/BLamy/onshape-mcp · https://github.com/altendky/onshape-mcp · https://github.com/clarsbyte/onshape-mcp

**Commentary / surveys**
- https://www.engineering.com/autodesk-announces-fusion-mcp-servers-and-more-ai-updates/
- https://www.colabsoftware.com/post/autodesk-fusion-mcp-faster-cad-same-bottleneck
- https://onemetrik.com/market-insights/claude-autodesk-fusion/
- https://www.promptarmor.com/connectors/autodesk-fusion
- https://snyk.io/articles/9-mcp-servers-for-computer-aided-drafting-cad-with-ai/
- https://develop3d.com/ai/claude-for-cad-blender-autodesk-fusion/
